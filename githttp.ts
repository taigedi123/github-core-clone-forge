// The git smart-HTTP surface: info/refs advertisements, upload-pack (protocol v2 with a
// v0 fallback) for clone and fetch, and receive-pack (v0) for push. Repositories are
// addressed as /{owner}/{repo}.git and must exist (created over REST) before git traffic
// is served, exactly as the suite's fixtures arrange.

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  collectReachable,
  isAncestor,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
} from './gitstore.ts';
import { Forge, VIEWER, type Repo } from './store.ts';
import { readBody } from './web.ts';

const ZERO = '0'.repeat(40);
const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k ofs-delta agent=git/forge-1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=git/forge-1.0';

// ------------------------------------------------------------------ pkt-lines

type Packet = { kind: 'data'; text: string } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function parsePackets(buffer: Buffer, from = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let at = from;
  while (at + 4 <= buffer.length) {
    const header = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', text: buffer.toString('utf8', at + 4, at + length) });
    at += length;
  }
  return { packets, rest: buffer.subarray(at) };
}

function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ advertisements

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0 || head === null) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  line(head, 'HEAD');
  for (const [name, oid] of refs) {
    line(oid, name);
    const object = repo.store.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      parts.push(pktLine(`${target} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=git/forge-1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ------------------------------------------------------------------ routing

export function isGitPath(pathname: string): boolean {
  return pathname.endsWith('/info/refs') || pathname.endsWith('/git-upload-pack') || pathname.endsWith('/git-receive-pack');
}

/** Extract {owner, repo} from a git path; null when the path is not a repo address. */
function gitRepoAddress(pathname: string): { owner: string; name: string; endpoint: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  return { owner: match[1] as string, name: match[2] as string, endpoint: match[3] as string };
}

export async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const address = gitRepoAddress(url.pathname);
  if (address === null) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const repo = address.owner === VIEWER.login ? forge.repo(address.name) : undefined;
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('repository not found');
    return;
  }
  if (address.endpoint === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('missing service');
      return;
    }
    const protocol = req.headers['git-protocol'];
    if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      res.end(advertisementV2());
      return;
    }
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
    res.end(advertisementV0(repo, service));
    return;
  }
  const body = await readBody(req);
  if (address.endpoint === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'];
    const version2 = typeof protocol === 'string' && protocol.includes('version=2');
    const out = version2 ? uploadPackV2(forge, repo, body) : uploadPackV0(forge, repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(out);
    return;
  }
  const out = receivePack(forge, repo, body);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(out);
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: Repo, rawArgs: string[]): Buffer {
  const args = rawArgs.map((arg) => arg.replace(/\n$/, ''));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  if (matches('HEAD')) {
    if (head !== null) {
      const attrs = symrefs || unborn ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`${head} HEAD${attrs}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let attrs = '';
    if (peel) {
      const object = repo.store.get(oid);
      if (object !== undefined && object.type === 'tag') {
        attrs = ` peeled:${parseTag(object.data).object}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${attrs}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const parsed: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, done: false };
  for (const line of lines) {
    const clean = line.replace(/\n$/, '');
    if (clean.startsWith('want ')) parsed.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) parsed.haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) parsed.shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) parsed.deepen = Number(clean.slice(7).trim());
    else if (clean === 'deepen-relative') parsed.deepenRelative = true;
    else if (clean === 'done') parsed.done = true;
  }
  return parsed;
}

/**
 * Objects reachable from `roots`, except that commits in `cut` contribute themselves and
 * their trees but not their parents (the client's shallow boundary).
 */
function closureWithCut(repo: Repo, roots: Iterable<string>, cut: ReadonlySet<string>): Set<string> {
  const store = repo.store;
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (oid: string): void => {
    if (!seen.has(oid)) {
      seen.add(oid);
      queue.push(oid);
    }
  };
  for (const root of roots) push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      const parsed = parseCommitSafe(repo, oid);
      if (parsed === null) continue;
      push(parsed.tree);
      if (!cut.has(oid)) for (const parent of parsed.parents) push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeSafe(repo, oid)) push(entry);
    }
  }
  return seen;
}

function parseCommitSafe(repo: Repo, oid: string): { tree: string; parents: string[] } | null {
  const object = repo.store.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const text = object.data.toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line === '') break;
  }
  return { tree, parents };
}

function parseTreeSafe(repo: Repo, oid: string): string[] {
  const object = repo.store.get(oid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: string[] = [];
  let at = 0;
  const data = object.data;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    out.push(data.toString('hex', nul + 1, nul + 21));
    at = nul + 21;
  }
  return out;
}

/**
 * Commit levels from the wants (want = level 1, its parent = level 2, ...), breadth-first.
 * The walk stops expanding at `cap` (levels beyond it are never assigned) and, when
 * `targets` is given, as soon as every target has a level — a depth-limited fetch only
 * ever needs levels near the tips, so it must not pay for the whole ancestry.
 */
function commitLevels(repo: Repo, wants: readonly string[], cap = Number.POSITIVE_INFINITY, targets?: ReadonlySet<string>): Map<string, number> {
  const levels = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(repo.store, want);
    if (commit !== null && !levels.has(commit)) {
      levels.set(commit, 1);
      frontier.push(commit);
    }
  }
  let level = 1;
  while (frontier.length > 0 && level < cap) {
    if (targets !== undefined && [...targets].every((target) => levels.has(target))) break;
    level += 1;
    const next: string[] = [];
    for (const commit of frontier) {
      const parsed = parseCommitSafe(repo, commit);
      if (parsed === null) continue;
      for (const parent of parsed.parents) {
        if (!levels.has(parent)) {
          levels.set(parent, level);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return levels;
}

interface FetchPlan {
  packObjects: string[];
  shallowLines: string[];
  commonAcks: string[];
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const store = repo.store;
  const clientShallow = new Set(request.shallow);
  // What the client provably has: its haves' closure with parents cut at its shallow
  // boundary, plus the boundary commits themselves (already in that closure).
  const hasSet = closureWithCut(repo, [...request.haves, ...request.shallow], clientShallow);
  const acks = request.haves.filter((have) => {
    const object = store.get(have);
    return object !== undefined && object.type === 'commit';
  });

  let depthLimit: number | null = null;
  if (request.deepen !== null && Number.isFinite(request.deepen)) {
    if (request.deepenRelative) {
      const shallowCommits = new Set<string>();
      for (const shallow of request.shallow) {
        const commit = peelToCommit(store, shallow);
        if (commit !== null) shallowCommits.add(commit);
      }
      const levels = commitLevels(repo, request.wants, Number.POSITIVE_INFINITY, shallowCommits);
      let base = 0;
      for (const commit of shallowCommits) base = Math.max(base, levels.get(commit) ?? 0);
      depthLimit = base + request.deepen;
    } else {
      depthLimit = request.deepen;
    }
  }

  let included: Set<string>;
  const shallowLines: string[] = [];
  if (depthLimit === null) {
    included = closureWithCut(repo, request.wants, new Set());
  } else {
    const levels = commitLevels(repo, request.wants, depthLimit);
    const includedCommits = new Set<string>();
    for (const [commit, level] of levels) if (level <= depthLimit) includedCommits.add(commit);
    // Objects: each included commit plus its own tree closure (never its parents), plus
    // any tag objects among the wants with their targets.
    included = new Set<string>();
    for (const commit of includedCommits) {
      included.add(commit);
      const parsed = parseCommitSafe(repo, commit);
      if (parsed !== null) for (const oid of closureWithCut(repo, [parsed.tree], new Set())) included.add(oid);
    }
    for (const want of request.wants) {
      if (store.get(want)?.type === 'tag') for (const oid of closureWithCut(repo, [want], new Set())) included.add(oid);
    }
    for (const oid of [...included]) {
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit' && !includedCommits.has(oid)) included.delete(oid);
    }
    // The new boundary: included commits with a parent outside the included set.
    const boundary = new Set<string>();
    for (const commit of includedCommits) {
      const parsed = parseCommitSafe(repo, commit);
      if (parsed === null) continue;
      if (parsed.parents.some((parent) => !includedCommits.has(parent))) boundary.add(commit);
    }
    for (const commit of boundary) shallowLines.push(`shallow ${commit}`);
    for (const shallow of request.shallow) {
      const commit = peelToCommit(store, shallow) ?? shallow;
      if (!boundary.has(commit)) shallowLines.push(`unshallow ${commit}`);
    }
  }

  const packObjects = [...included].filter((oid) => !hasSet.has(oid) && store.get(oid) !== undefined);
  return { packObjects, shallowLines, commonAcks: acks };
}

function cachedPack(forge: Forge, repo: Repo, objects: readonly string[]): Buffer {
  const key = `${repo.name}@${repo.version}:${objects.length}:${objects[0] ?? ''}:${objects[objects.length - 1] ?? ''}`;
  const hit = forge.packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(repo.store, objects);
  if (forge.packCache.size > 64) forge.packCache.clear();
  forge.packCache.set(key, pack);
  return pack;
}

function uploadPackV2(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => (packet as { text: string }).text);
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    return lsRefs(repo, lines.slice(1));
  }
  if (command === 'command=fetch') {
    const request = parseFetchArgs(lines.slice(1));
    const plan = planFetch(repo, request);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (plan.commonAcks.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const ack of plan.commonAcks) parts.push(pktLine(`ACK ${ack}\n`));
    }
    parts.push(DELIM);
    if (plan.shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
      parts.push(DELIM);
    }
    const clientWantsObjects = request.wants.some((want) => repo.store.get(want) !== undefined);
    if (plan.packObjects.length > 0 || (request.wants.length > 0 && clientWantsObjects)) {
      const pack = cachedPack(forge, repo, plan.packObjects);
      parts.push(pktLine('packfile\n'));
      parts.push(sideband(pack));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([pktLine('error: unknown command\n'), FLUSH]);
}

function uploadPackV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  const wants: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const clean = packet.text.replace(/\n$/, '');
    if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0] as string);
  }
  const objects = wants.length === 0 ? [] : [...collectReachable(repo.store, wants)];
  const pack = writePack(repo.store, objects);
  return Buffer.concat([pktLine('NAK\n'), sideband(pack), FLUSH]);
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  oldId: string;
  newId: string;
  ref: string;
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePackets(body);
  const commands: RefCommand[] = [];
  let sidebandWanted = false;
  let reportWanted = false;
  packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    let text = packet.text.replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        sidebandWanted = caps.includes('side-band-64k') || caps.includes('side-band');
        reportWanted = caps.includes('report-status');
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldId: parts[0] as string, newId: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  });

  let unpackLine = 'unpack ok\n';
  const hasPack = rest.length > 0 && commands.some((command) => command.newId !== ZERO);
  if (hasPack) {
    try {
      const parsed = readPack(rest, repo.store);
      for (const [oid, object] of parsed.objects) repo.store.putRaw(oid, object);
    } catch {
      unpackLine = 'unpack error: corrupt pack\n';
    }
  }

  const results: string[] = [];
  let mutated = false;
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push(`ng ${command.ref} ${reason}\n`);
    };
    if (unpackLine !== 'unpack ok\n' && command.newId !== ZERO) {
      fail('unpack failed');
      continue;
    }
    if (command.newId === ZERO) {
      if (!repo.refs.has(command.ref)) {
        fail('reference not found');
        continue;
      }
      repo.refs.delete(command.ref);
      mutated = true;
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = repo.store.get(command.newId);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      fail('invalid object');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO;
    if (current !== command.oldId) {
      fail('reference is stale');
      continue;
    }
    if (command.oldId !== ZERO && command.ref.startsWith('refs/heads/')) {
      const oldCommit = peelToCommit(repo.store, command.oldId);
      const newCommit = peelToCommit(repo.store, command.newId);
      if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(repo.store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newId);
    mutated = true;
    results.push(`ok ${command.ref}\n`);
  }
  if (mutated) repo.version += 1;
  void forge;

  if (!reportWanted) return FLUSH;
  const report = [unpackLine, ...results];
  if (sidebandWanted) {
    return Buffer.concat([...report.map((line) => pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]))), FLUSH]);
  }
  return Buffer.concat([...report.map((line) => pktLine(line)), FLUSH]);
}
