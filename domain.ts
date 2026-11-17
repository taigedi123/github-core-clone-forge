// Domain operations shared by the three surfaces (REST v3, GraphQL v4, MCP): the JSON
// shapes each surface returns for a repository, an issue and a pull request, and the
// operations that create and merge them, so every surface sees the same objects.

import {
  buildCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  treeFromFlat,
} from './gitstore.ts';
import { Forge, VIEWER, forgeAuthor, type Issue, type PullRequest, type Repo } from './store.ts';

export type Json = Record<string, unknown>;

export function userJson(): Json {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    type: VIEWER.type,
    name: VIEWER.name,
    email: VIEWER.email,
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    description: repo.description,
    fork: false,
    created_at: new Date(repo.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(repo.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    pushed_at: new Date(repo.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

/** The opaque GraphQL global id of a repository (never the plain database id). */
export function repoNodeId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url');
}

export function issueNodeId(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function pullNodeId(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function commentNodeId(id: number): string {
  return Buffer.from(`IssueComment:${id}`, 'utf8').toString('base64url');
}

/** Decode a global id this forge minted; null for anything else. */
export function decodeNodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    assignees: [],
    comments: issue.comments.length,
    created_at: new Date(issue.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(issue.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    closed_at: issue.closedSeq === null ? null : new Date(issue.closedSeq * 1000).toISOString().replace('.000Z', 'Z'),
    pull_request: undefined,
  };
}

export function commentJson(repo: Repo, comment: { id: number; body: string; createdSeq: number }): Json {
  void repo;
  return {
    id: comment.id,
    node_id: commentNodeId(comment.id),
    body: comment.body,
    user: userJson(),
    created_at: new Date(comment.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(comment.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

/** The current tip of a branch name in a repo (a commit sha), or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Json {
  void forge;
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${VIEWER.login}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${VIEWER.login}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : new Date(pull.mergedSeq * 1000).toISOString().replace('.000Z', 'Z'),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: new Date(pull.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date(pull.createdSeq * 1000).toISOString().replace('.000Z', 'Z'),
    draft: false,
  };
}

// ------------------------------------------------------------------ operations

export type CreateIssueResult = { ok: true; issue: Issue } | { ok: false; status: number; message: string };

export function createIssue(forge: Forge, repo: Repo, input: { title?: unknown; body?: unknown; labels?: unknown }): CreateIssueResult {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return { ok: false, status: 422, message: 'Validation Failed: title is required' };
  const body = typeof input.body === 'string' ? input.body : '';
  const labelNames: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const entry of input.labels) {
      const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? String((entry as Json).name ?? '') : '';
      if (name === '' || !repo.labels.has(name)) {
        return { ok: false, status: 422, message: `Validation Failed: label "${name}" does not exist` };
      }
      labelNames.push(name);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    id: forge.nextIssueId(),
    title,
    body,
    state: 'open',
    labels: labelNames,
    comments: [],
    createdSeq: forge.tick(),
    closedSeq: null,
  };
  repo.issues.set(number, issue);
  return { ok: true, issue };
}

export type CreatePullResult = { ok: true; pull: PullRequest } | { ok: false; status: number; message: string };

export function createPull(
  forge: Forge,
  repo: Repo,
  input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): CreatePullResult {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const head = typeof input.head === 'string' ? input.head.replace(/^[^:]+:/, '') : '';
  const base = typeof input.base === 'string' ? input.base : '';
  if (head === '' || base === '') return { ok: false, status: 422, message: 'Validation Failed: head and base are required' };
  const headTip = branchTip(repo, head);
  if (headTip === null) return { ok: false, status: 422, message: `Validation Failed: head branch "${head}" does not exist` };
  const baseTip = branchTip(repo, base);
  if (baseTip === null) return { ok: false, status: 422, message: `Validation Failed: base branch "${base}" does not exist` };
  if (head === base) return { ok: false, status: 422, message: 'Validation Failed: head and base are the same branch' };
  const store = repo.store;
  const headCommit = peelToCommit(store, headTip) ?? headTip;
  const baseCommit = peelToCommit(store, baseTip) ?? baseTip;
  if (isAncestor(store, headCommit, baseCommit)) {
    return { ok: false, status: 422, message: `No commits between ${base} and ${head}` };
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return { ok: false, status: 422, message: `A pull request already exists for ${VIEWER.login}:${head}` };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRequest = {
    number,
    id: forge.nextIssueId(),
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    createdSeq: forge.tick(),
  };
  repo.pulls.set(number, pull);
  return { ok: true, pull };
}

/**
 * A three-way merge of the head branch into the base branch at the tree level.
 * Answers the merged flat tree, or null when a path changed on both sides.
 */
export function trialMergeTree(repo: Repo, baseTip: string, headTip: string): Map<string, string> | null {
  const store = repo.store;
  const baseCommit = peelToCommit(store, baseTip) ?? baseTip;
  const headCommit = peelToCommit(store, headTip) ?? headTip;
  const base = mergeBase(store, baseCommit, headCommit) ?? baseCommit;
  const baseObject = store.get(base);
  const baseTipObject = store.get(baseCommit);
  const headObject = store.get(headCommit);
  if (baseObject === undefined || baseTipObject === undefined || headObject === undefined) return null;
  const ancestorFlat = flattenTree(store, parseCommit(baseObject.data).tree);
  const baseFlat = flattenTree(store, parseCommit(baseTipObject.data).tree);
  const headFlat = flattenTree(store, parseCommit(headObject.data).tree);
  const merged = new Map<string, string>();
  const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    if (inHead === inBase) {
      if (inBase !== undefined) merged.set(path, inBase);
    } else if (ancestor === inBase) {
      if (inHead !== undefined) merged.set(path, inHead);
    } else if (ancestor === inHead) {
      if (inBase !== undefined) merged.set(path, inBase);
    } else {
      return null;
    }
  }
  return merged;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; status: number; message: string };

/** Squash-merge an open pull request onto its base branch (the only method the suite uses). */
export function mergePull(forge: Forge, repo: Repo, pull: PullRequest): MergeResult {
  if (pull.state !== 'open' || pull.merged) return { ok: false, status: 405, message: 'Pull Request is not open' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, status: 405, message: 'Pull Request branch is gone' };
  const mergedFlat = trialMergeTree(repo, baseTip, headTip);
  if (mergedFlat === null) return { ok: false, status: 405, message: 'Pull Request is not mergeable: merge conflict' };
  const store = repo.store;
  const tree = treeFromFlat(store, mergedFlat);
  const stamp = forge.tick();
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const commit = buildCommit({
    tree,
    parents: [peelToCommit(store, baseTip) ?? baseTip],
    author: forgeAuthor(stamp),
    committer: forgeAuthor(stamp),
    message,
  });
  const sha = store.put('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.version += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = stamp;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** The GraphQL mergeable state of a pull request. */
export function mergeableState(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  return trialMergeTree(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** Count added/removed lines between two texts with a longest-common-subsequence diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lcs = lcsLength(oldLines, newLines);
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, current[j - 1] as number);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] as number;
}

/** The files a pull request changes: its merge-base tree against its head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const store = repo.store;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const baseCommit = peelToCommit(store, baseTip) ?? baseTip;
  const headCommit = peelToCommit(store, headTip) ?? headTip;
  const base = mergeBase(store, baseCommit, headCommit) ?? baseCommit;
  const baseObject = store.get(base);
  const headObject = store.get(headCommit);
  if (baseObject === undefined || headObject === undefined) return [];
  const fromFlat = flattenTree(store, parseCommit(baseObject.data).tree);
  const toFlat = flattenTree(store, parseCommit(headObject.data).tree);
  const files: PullFile[] = [];
  const paths = [...new Set([...fromFlat.keys(), ...toFlat.keys()])].sort();
  for (const path of paths) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from === to) continue;
    const oldText = from === undefined ? '' : (store.get(from)?.data.toString('utf8') ?? '');
    const newText = to === undefined ? '' : (store.get(to)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    files.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: to ?? null,
    });
  }
  return files;
}
