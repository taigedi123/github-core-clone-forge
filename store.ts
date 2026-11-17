// The forge's data model: one user (the login the trial's bearer <redacted> names), their
// repositories, and everything a repository holds — git objects and refs, issues, pull
// requests, comments and labels. All state is in memory; a trial starts from an empty
// forge and the suite builds every fixture through the API.
//
// Time is a logical clock seeded from MAKEFUN_TRIAL_NOW: every timestamp the forge mints
// is the seed plus a per-process sequence of seconds, so two runs of the same trial (the
// live pass and its replay) produce byte-identical state.

import {
  ObjectStore,
  buildCommit,
  collectReachable,
  flattenTree,
  parseCommit,
  treeFromFlat,
} from './gitstore.ts';

/** The one user of this forge: the scenario login the suite's token names. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The author line every forge-made commit carries (the viewer's identity). */
export function forgeAuthor(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  closedSeq: number | null;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  /** Bumped on every mutation of the git state; keys the pack cache. */
  version: number;
}

const TRIAL_NOW_FALLBACK = '2026-01-01T00:00:00Z';

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private clockSeq = 0;
  private readonly clockBaseSec: number;
  /** Pack cache: key -> pack bytes, invalidated by a repo's version counter. */
  readonly packCache = new Map<string, Buffer>();

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? TRIAL_NOW_FALLBACK;
    const parsed = Date.parse(now);
    this.clockBaseSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.parse(TRIAL_NOW_FALLBACK) / 1000);
  }

  /** The next logical timestamp: seconds since the epoch, strictly increasing. */
  tick(): number {
    this.clockSeq += 1;
    return this.clockBaseSec + this.clockSeq;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString().replace('.000Z', 'Z');
  }

  isoAt(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
  }

  createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch !== undefined && options.defaultBranch !== '' ? options.defaultBranch : 'main',
      createdSeq: this.tick(),
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      version: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  repo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** The tip commit of a ref, or null when the ref does not resolve to a commit. */
  refTip(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    return oid === undefined ? null : oid;
  }

  /** The default branch's full ref name. */
  defaultRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a REST `ref` parameter (branch name, full ref, HEAD or a commit sha) to a commit. */
  resolveRef(repo: Repo, ref: string | null): string | null {
    if (ref === null || ref === '' || ref === 'HEAD') {
      return this.refTip(repo, this.defaultRef(repo));
    }
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch !== undefined) return byBranch;
    const byRef = repo.refs.get(ref);
    if (byRef !== undefined) return byRef;
    const object = repo.store.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    return null;
  }

  /**
   * Commit a single file change on a branch, GitHub-contents style: the branch is created
   * at the default branch's tip when it does not exist yet. Answers the new commit's sha
   * and the blob's sha, or null when the path collides with a directory.
   */
  commitFile(
    repo: Repo,
    options: { branch: string; path: string; content: Buffer | null; message: string },
  ): { commitSha: string; blobSha: string | null } | null {
    const ref = `refs/heads/${options.branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) {
      parent = repo.refs.get(this.defaultRef(repo));
      if (parent === undefined) {
        // An unborn repository: this file change is its first commit, on the named branch.
        const flat = new Map<string, string>();
        let blobSha: string | null = null;
        if (options.content !== null) {
          blobSha = repo.store.put('blob', options.content);
          flat.set(options.path, blobSha);
        }
        const tree = treeFromFlat(repo.store, flat);
        const stamp = this.tick();
        const first = buildCommit({
          tree,
          parents: [],
          author: forgeAuthor(stamp),
          committer: forgeAuthor(stamp),
          message: options.message,
        });
        const firstSha = repo.store.put('commit', first);
        repo.refs.set(ref, firstSha);
        repo.version += 1;
        return { commitSha: firstSha, blobSha };
      }
    }
    const parentCommit = repo.store.get(parent);
    if (parentCommit === undefined || parentCommit.type !== 'commit') return null;
    const flat = flattenTree(repo.store, parseCommit(parentCommit.data).tree);
    let blobSha: string | null = null;
    if (options.content === null) {
      flat.delete(options.path);
    } else {
      blobSha = repo.store.put('blob', options.content);
      flat.set(options.path, blobSha);
    }
    const tree = treeFromFlat(repo.store, flat);
    const stamp = this.tick();
    const commit = buildCommit({
      tree,
      parents: [parent],
      author: forgeAuthor(stamp),
      committer: forgeAuthor(stamp),
      message: options.message,
    });
    const commitSha = repo.store.put('commit', commit);
    repo.refs.set(ref, commitSha);
    repo.version += 1;
    return { commitSha, blobSha };
  }

  /** Every object reachable from all of a repo's refs (for a full clone's pack). */
  reachableFromRefs(repo: Repo): Set<string> {
    return collectReachable(repo.store, repo.refs.values());
  }
}
