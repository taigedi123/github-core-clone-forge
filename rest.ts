// The REST v3 surface under /api/v3: repositories, contents, refs, commits, labels,
// issues, comments and pull requests, shaped like GitHub's API. The suite's one user is
// the viewer; repositories live under the viewer's login only.

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  branchTip,
  commentJson,
  createIssue,
  createPull,
  issueJson,
  labelJson,
  mergePull,
  pullFiles,
  pullJson,
  repoJson,
  userJson,
} from './domain.ts';
import {
  parseCommit,
  parseTree,
  peelToCommit,
  walkCommits,
} from './gitstore.ts';
import { Forge, VIEWER, type Repo } from './store.ts';
import { asObject, asString, paginate, parseJsonBody, readBody, sendEmpty, sendError, sendJson } from './web.ts';

const SCOPES = 'repo, user, admin:org';

export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeSegment(part));
  // segments[0..1] are "api" and "v3" (the app only routes /api/v3 here).
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: 'https://api.github.com/user', message: 'API root' }, { 'x-oauth-scopes': SCOPES });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  if (head === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
    return;
  }

  if (head === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson(), { 'x-oauth-scopes': SCOPES });
    return;
  }

  if (head === 'user' && rest[1] === 'repos') {
    if (rest.length === 2 && method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(repo));
      const { page, headers } = paginate(all, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (rest.length === 2 && method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      const name = asString(body.name);
      if (name === '') {
        sendError(res, 422, 'Repository creation failed: name is required');
        return;
      }
      if (forge.repo(name) !== undefined) {
        sendError(res, 422, 'Repository creation failed: name already exists on this account');
        return;
      }
      const repo = forge.createRepo(name, {
        description: asString(body.description),
        private: body.private === true,
        defaultBranch: asString(body.default_branch),
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  if (head === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    if (owner !== VIEWER.login) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const repo = forge.repo(repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleRepo(forge, req, res, url, repo, rest.slice(3), method);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Read and parse a JSON body; on malformed JSON, sends the 400 and answers null. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
  return asObject(parsed.value);
}

async function handleRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  parts: string[],
  method: string,
): Promise<void> {
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      sendEmpty(res, 204);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const head = parts[0] as string;

  if (head === 'contents') {
    await handleContents(forge, req, res, url, repo, parts.slice(1).join('/'), method);
    return;
  }

  if (head === 'git' && parts[1] === 'refs') {
    await handleRefs(forge, req, res, repo, parts.slice(2), method);
    return;
  }

  if (head === 'branches' && parts.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: peelToCommit(repo.store, oid) ?? oid, url: '' },
        protected: false,
        _links: {},
      }));
    const { page, headers } = paginate(branches, url, req);
    sendJson(res, 200, page, headers);
    return;
  }

  if (head === 'branches' && parts.length >= 2) {
    const branch = parts.slice(1).join('/');
    if (method === 'GET') {
      const tip = branchTip(repo, branch);
      if (tip === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const commitSha = peelToCommit(repo.store, tip) ?? tip;
      sendJson(res, 200, {
        name: branch,
        commit: { sha: commitSha, url: '' },
        protected: false,
        _links: {},
      });
      return;
    }
  }

  if (head === 'commits' && parts.length === 1 && method === 'GET') {
    const refParam = url.searchParams.get('sha');
    const tip = forge.resolveRef(repo, refParam);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const commits = walkCommits(repo.store, tip).map((oid) => {
      const object = repo.store.get(oid);
      const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
      return commitJson(repo, oid, parsed);
    });
    const { page, headers } = paginate(commits, url, req);
    sendJson(res, 200, page, headers);
    return;
  }

  if (head === 'labels') {
    await handleLabels(forge, req, res, url, repo, parts.slice(1), method);
    return;
  }

  if (head === 'issues') {
    await handleIssues(forge, req, res, url, repo, parts.slice(1), method);
    return;
  }

  if (head === 'pulls') {
    await handlePulls(forge, req, res, url, repo, parts.slice(1), method);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function commitJson(repo: Repo, sha: string, parsed: { tree: string; parents: string[]; message: string; author: string }): Record<string, unknown> {
  const author = parseAuthorLine(parsed.author);
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.id}:${sha}`, 'utf8').toString('base64url'),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: author.name, email: author.email, date: author.date },
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree, url: '' },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: parsed.parents.map((parent) => ({ sha: parent, url: '' })),
  };
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: VIEWER.name, email: VIEWER.email, date: new Date(0).toISOString() };
  const epoch = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

async function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  path: string,
  method: string,
): Promise<void> {
  const store = repo.store;
  if (method === 'GET') {
    const refParam = url.searchParams.get('ref');
    const tip = forge.resolveRef(repo, refParam);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const commit = store.get(tip);
    if (commit === undefined || commit.type !== 'commit') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const treeSha = parseCommit(commit.data).tree;
    if (path === '') {
      sendJson(res, 200, directoryJson(repo, treeSha, ''));
      return;
    }
    const found = lookupPath(repo, treeSha, path);
    if (found === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (found.kind === 'tree') {
      sendJson(res, 200, directoryJson(repo, found.sha, path));
      return;
    }
    const blob = store.get(found.sha);
    if (blob === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      sha: found.sha,
      content: blob.data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const body = await readJson(req, res);
    if (body === null) return;
    const contentBase64 = asString(body.content);
    const message = asString(body.message) || 'Update file';
    const branch = asString(body.branch) || repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    // Optimistic concurrency: a caller-supplied sha must match the file's current blob.
    if (typeof body.sha === 'string' && tip !== undefined) {
      const commit = store.get(tip);
      const current = commit !== undefined && commit.type === 'commit' ? lookupPath(repo, parseCommit(commit.data).tree, path) : null;
      const currentSha = current !== null && current.kind === 'blob' ? current.sha : undefined;
      if (currentSha !== body.sha) {
        sendError(res, 409, 'Conflict: the file sha does not match the current content');
        return;
      }
    }
    const existed = tip !== undefined && (() => {
      const commit = store.get(tip);
      return commit !== undefined && commit.type === 'commit' && lookupPath(repo, parseCommit(commit.data).tree, path)?.kind === 'blob';
    })();
    const bytes = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const result = forge.commitFile(repo, { branch, path, content: bytes, message });
    if (result === null || result.blobSha === null) {
      sendError(res, 422, 'Validation Failed');
      return;
    }
    sendJson(res, existed ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readJson(req, res);
    if (body === null) return;
    const message = asString(body.message) || 'Delete file';
    const branch = asString(body.branch) || repo.defaultBranch;
    const result = forge.commitFile(repo, { branch, path, content: null, message });
    if (result === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Walk a tree to a path; answers the blob or subtree found there. */
function lookupPath(repo: Repo, treeSha: string, path: string): { kind: 'blob' | 'tree'; sha: string } | null {
  const store = repo.store;
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let index = 0; index < parts.length; index += 1) {
    const treeObject = store.get(current);
    if (treeObject === undefined || treeObject.type !== 'tree') return null;
    const entries = parseTree(treeObject.data);
    const entry = entries.find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) return { kind: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'tree', sha: treeSha };
}

function directoryJson(repo: Repo, treeSha: string, basePath: string): Record<string, unknown>[] {
  const treeObject = repo.store.get(treeSha);
  if (treeObject === undefined || treeObject.type !== 'tree') return [];
  return parseTree(treeObject.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.store.get(entry.oid)?.data.length ?? 0),
  }));
}

async function handleRefs(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  method: string,
): Promise<void> {
  if (parts.length === 0 && method === 'POST') {
    const body = await readJson(req, res);
    if (body === null) return;
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === '' || sha === '' || repo.store.get(sha) === undefined) {
      sendError(res, 422, 'Validation Failed: ref and a known sha are required');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    repo.version += 1;
    void forge;
    sendJson(res, 201, { ref, node_id: '', url: '', object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
    return;
  }
  if (method === 'GET') {
    // GET /git/refs/{ref...}: the suite asks for refs/heads/<branch>.
    const ref = parts.join('/');
    const candidates = ref.startsWith('refs/') ? [ref] : [`refs/${ref}`];
    for (const candidate of candidates) {
      const sha = repo.refs.get(candidate);
      if (sha !== undefined) {
        sendJson(res, 200, { ref: candidate, node_id: '', url: '', object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  sendError(res, 404, 'Not Found');
}

async function handleLabels(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  parts: string[],
  method: string,
): Promise<void> {
  void forge;
  if (parts.length === 0) {
    if (method === 'GET') {
      const all = [...repo.labels.values()].map((label) => labelJson(repo, label.name));
      const { page, headers } = paginate(all, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      const name = asString(body.name);
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (repo.labels.has(name)) {
        sendError(res, 422, 'Validation Failed: name has already been taken');
        return;
      }
      repo.labels.set(name, {
        name,
        color: asString(body.color) || 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      });
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
  }
  sendError(res, 404, 'Not Found');
}

async function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  parts: string[],
  method: string,
): Promise<void> {
  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      void sort;
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const all = issues.map((issue) => issueJson(repo, issue));
      const { page, headers } = paginate(all, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      const created = createIssue(forge, repo, body);
      if (!created.ok) {
        sendError(res, created.status, created.message);
        return;
      }
      sendJson(res, 201, issueJson(repo, created.issue));
      return;
    }
  }

  const number = Number(parts[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (parts.length === 1 && issue !== undefined) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === null) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSeq = forge.tick();
      } else if (body.state === 'open') {
        issue.state = 'open';
        issue.closedSeq = null;
      }
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : asString(asObject(entry).name);
          if (!repo.labels.has(name)) {
            sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
            return;
          }
          names.push(name);
        }
        issue.labels = names;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
  }

  if (parts.length === 2 && parts[1] === 'comments' && (issue !== undefined || pull !== undefined)) {
    const comments = issue !== undefined ? issue.comments : pullCommentList(repo, number);
    if (method === 'GET') {
      const all = comments.map((comment) => commentJson(repo, comment));
      const { page, headers } = paginate(all, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      const comment = { id: forge.nextCommentId(), body: asString(body.body), createdSeq: forge.tick() };
      comments.push(comment);
      sendJson(res, 201, commentJson(repo, comment));
      return;
    }
  }

  if (parts.length === 2 && parts[1] === 'labels' && issue !== undefined && method === 'POST') {
    const body = await readJson(req, res);
    if (body === null) return;
    const names = Array.isArray(body.labels) ? body.labels.map((entry) => asString(entry)) : [];
    for (const name of names) {
      if (!repo.labels.has(name)) {
        sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
        return;
      }
      if (!issue.labels.includes(name)) issue.labels.push(name);
    }
    sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)));
    return;
  }

  sendError(res, 404, 'Not Found');
}

// Pull-request comments live in a side table: the forge's Issue records carry comments,
// and a pull request's conversation comments are kept per pull number.
const pullCommentsByRepo = new WeakMap<Repo, Map<number, { id: number; body: string; createdSeq: number }[]>>();

function pullCommentList(repo: Repo, number: number): { id: number; body: string; createdSeq: number }[] {
  let table = pullCommentsByRepo.get(repo);
  if (table === undefined) {
    table = new Map();
    pullCommentsByRepo.set(repo, table);
  }
  let list = table.get(number);
  if (list === undefined) {
    list = [];
    table.set(number, list);
  }
  return list;
}

async function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  parts: string[],
  method: string,
): Promise<void> {
  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const all = pulls.map((pull) => pullJson(forge, repo, pull));
      const { page, headers } = paginate(all, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      const created = createPull(forge, repo, body);
      if (!created.ok) {
        sendError(res, created.status, created.message);
        return;
      }
      sendJson(res, 201, pullJson(forge, repo, created.pull));
      return;
    }
  }

  const number = Number(parts[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (parts.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(forge, repo, pull));
    return;
  }

  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const { page, headers } = paginate(files, url, req);
    sendJson(res, 200, page, headers);
    return;
  }

  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    const body = await readJson(req, res);
    if (body === null) return;
    const merged = mergePull(forge, repo, pull);
    if (!merged.ok) {
      sendError(res, merged.status, merged.message);
      return;
    }
    sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}
