// The git object model for the forge: SHA-1 addressed objects (commit, tree, blob, tag),
// packfile reading and writing, reachability, ancestry and tree operations. Node built-ins
// only: node:crypto for SHA-1 and node:zlib for the pack streams. Everything is kept in
// memory; an object, once stored, is never mutated, so ids are stable for the life of
// the process.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: readonly (GitObjectType | '')[] = ['', 'commit', 'tree', 'blob', 'tag', '', '', ''];

/** The git object id of a payload: sha1 of "<type> <length>\0" followed by the bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** A repository's object database: an oid -> object map plus the operations over it. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object under an id the caller already verified (a pack entry's own id). */
  putRaw(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  /** Store an object and answer its id (idempotent: the same bytes give the same id). */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// ------------------------------------------------------------------ commits, trees, tags

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: { object: string; type: string; tag: string; tagger: string; message: string } = {
    object: '',
    type: '',
    tag: '',
    tagger: '',
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object: a run of "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const mode = data.toString('ascii', at, space);
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** git's tree entry order: by name, with directories compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ graph walks

/** Every object reachable from `tips` (commits walk to trees and parents, tags to their target). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commit a tag chain or ref value resolves to (peeling), or null when it is not a commit. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The object id a tag ref peels to for advertisement: the commit under the tag, when there is one. */
export function peelTag(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(store, oid);
}

/** Commit ancestry: the set of commits reachable from `tip` (including `tip`), parents only. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits (the one with the shortest combined distance), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = commitAncestors(store, a);
  if (ancestorsA.has(b)) return b;
  const ancestorsB = commitAncestors(store, b);
  if (ancestorsB.has(a)) return a;
  // Breadth-first from both tips; the first commit met from both sides wins.
  const distA = new Map<string, number>([[a, 0]]);
  const distB = new Map<string, number>([[b, 0]]);
  let frontierA = [a];
  let frontierB = [b];
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const step = (frontier: string[], dist: Map<string, number>, other: Map<string, number>): string[] => {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (dist.has(parent)) continue;
        const d = (dist.get(oid) ?? 0) + 1;
        dist.set(parent, d);
        next.push(parent);
        const otherDist = other.get(parent);
        if (otherDist !== undefined && d + otherDist < bestScore) {
          bestScore = d + otherDist;
          best = parent;
        }
      }
    }
    return next;
  };
  while ((frontierA.length > 0 || frontierB.length > 0) && best === null) {
    frontierA = step(frontierA, distA, distB);
    frontierB = step(frontierB, distB, distA);
  }
  return best;
}

/** Commits in walk order from a tip: newest first (a commit always precedes its parents). */
export function walkCommits(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return order;
}

// ------------------------------------------------------------------ trees as flat maps

/** Flatten a tree into path -> blob oid, walking subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, childOid] of flattenTree(store, entry.oid, path)) out.set(childPath, childOid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** Build (and store) a tree from a flat path -> blob oid map; answers the root tree oid. */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ packfiles

/** Serialize objects into a version-2 packfile (whole objects, zlib-deflated, no deltas). */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) throw new Error(`writePack: missing object ${oid}`);
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (TYPE_IDS[object.type] << 4) | (size & 0x0f);
    let rest = size >>> 4;
    while (rest > 0) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
      rest >>>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (`data`) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a packfile into an oid -> object map. OFS_DELTA and REF_DELTA entries are resolved
 * against the pack itself and, for REF_DELTA, against `external` (objects the caller
 * already holds, for thin packs). The trailer checksum is verified.
 */
export function readPack(pack: Buffer, external?: ObjectStore): PackReadResult {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let at = 12;
  const end = pack.length - 20;
  interface PendingDelta {
    readonly kind: 'ofs' | 'ref';
    readonly baseOid?: string;
    readonly baseOffset?: number;
    readonly entryOffset: number;
    readonly delta: Buffer;
  }
  const pending: PendingDelta[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: { kind: 'ofs'; baseOffset: number } | { kind: 'ref'; baseOid: string } | null = null;
    if (typeId === 6) {
      // OFS_DELTA: a variable-length negative offset to the base entry.
      let back = pack[at] as number;
      at += 1;
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      base = { kind: 'ofs', baseOffset: entryOffset - offset };
    } else if (typeId === 7) {
      base = { kind: 'ref', baseOid: pack.toString('hex', at, at + 20) };
      at += 20;
    }
    const inflated = inflateWithLength(pack.subarray(at, end));
    at += inflated.consumed;
    const data = inflated.data;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    if (base !== null) {
      pending.push({ ...base, entryOffset, delta: data });
    } else {
      const type = ID_TYPES[typeId] as GitObjectType;
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(entryOffset, oid);
    }
  }
  // Resolve deltas in dependency order (a delta's base may itself be a delta entry).
  let waiting = pending;
  while (waiting.length > 0) {
    const still: PendingDelta[] = [];
    let progressed = false;
    for (const delta of waiting) {
      const baseOid = delta.kind === 'ofs' ? byOffset.get(delta.baseOffset as number) : delta.baseOid;
      const baseObject = baseOid !== undefined ? (objects.get(baseOid) ?? external?.get(baseOid)) : undefined;
      if (baseOid === undefined || baseObject === undefined) {
        still.push(delta);
        continue;
      }
      const data = applyDelta(baseObject.data, delta.delta);
      const oid = hashObject(baseObject.type, data);
      objects.set(oid, { type: baseObject.type, data });
      byOffset.set(delta.entryOffset, oid);
      progressed = true;
    }
    if (!progressed) throw new Error('unresolvable pack delta');
    waiting = still;
  }
  return { objects, count };
}

/**
 * Inflate one zlib stream from the front of `buffer`, answering the data and how many input
 * bytes the stream consumed. Node's synchronous inflate does not report consumption, but it
 * throws on a truncated stream and ignores bytes past the stream's end, so success is
 * monotone in the prefix length and the smallest prefix that inflates is exactly the
 * stream: a binary search finds it in log2(n) inflations of a small entry.
 */
function inflateWithLength(buffer: Buffer): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buffer.length;
  let answer: { data: Buffer; consumed: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buffer.subarray(0, mid));
      answer = { data, consumed: mid };
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (answer === null) throw new Error('corrupt pack entry stream');
  return answer;
}
