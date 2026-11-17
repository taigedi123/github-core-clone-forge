// The GraphQL v4 surface at /api/graphql: a small parser and executor covering the
// schema the suite exercises — viewer, repository, node, __type introspection, issue and
// pull-request connections, and the create/close/merge/comment mutations. Global ids are
// the forge's opaque base64 encodings, stable per object and distinct from database ids.

import {
  commentNodeId,
  createIssue,
  createPull,
  decodeNodeId,
  issueNodeId,
  mergePull,
  mergeableState,
  pullFiles,
  pullNodeId,
  repoNodeId,
} from './domain.ts';
import { Forge, VIEWER, type Issue, type PullRequest, type Repo } from './store.ts';

// ------------------------------------------------------------------ lexer/parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: Value | null }[];
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '@', '$', '!', '=']);

function tokenize(source: string): (string | { str: string })[] {
  const tokens: (string | { str: string })[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push('...');
      at += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push(ch);
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        const text = source.slice(at + 3, end < 0 ? source.length : end);
        tokens.push({ str: text });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let text = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const esc = source[at + 1] as string;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          at += 2;
        } else {
          text += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ str: text });
      continue;
    }
    const match = /^[_A-Za-z][_0-9A-Za-z]*|^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
    if (match !== null) {
      tokens.push(match[0]);
      at += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: (string | { str: string })[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | { str: string } | undefined {
    return this.tokens[this.at];
  }

  private next(): string | { str: string } {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token !== value) throw new Error(`expected ${value}`);
  }

  private skip(value: string): boolean {
    if (this.peek() === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private name(): string {
    const token = this.next();
    if (typeof token !== 'string' || token === '...' || PUNCT.has(token)) throw new Error('expected a name');
    return token;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', name: null, varDefs: [], selection: this.selectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        const opType = token === 'mutation' ? 'mutation' : 'query';
        let opName: string | null = null;
        if (typeof this.peek() === 'string' && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') {
          opName = this.name();
        }
        const varDefs: Operation['varDefs'] = [];
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.name();
            this.expect(':');
            this.typeRef();
            let defaultValue: Value | null = null;
            if (this.skip('=')) defaultValue = this.value();
            varDefs.push({ name: varName, defaultValue });
          }
        }
        this.directives();
        operations.push({ type: opType, name: opName, varDefs, selection: this.selectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.name();
        const on = this.name();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.name();
        this.directives();
        fragments.set(fragName, { typeCondition, selection: this.selectionSet() });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  private typeRef(): void {
    if (this.skip('[')) {
      this.typeRef();
      this.expect(']');
    } else {
      this.name();
    }
    this.skip('!');
  }

  private directives(): void {
    while (this.skip('@')) {
      this.name();
      if (this.skip('(')) {
        while (!this.skip(')')) {
          this.name();
          this.expect(':');
          this.value();
        }
      }
    }
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) {
      if (this.skip('...')) {
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.name();
          this.directives();
          selections.push({ kind: 'inline', typeCondition, selection: this.selectionSet() });
        } else {
          const name = this.name();
          this.directives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let fieldName = this.name();
      let alias: string | null = null;
      if (this.skip(':')) {
        alias = fieldName;
        fieldName = this.name();
      }
      const args: FieldNode['args'] = [];
      if (this.skip('(')) {
        while (!this.skip(')')) {
          const argName = this.name();
          this.expect(':');
          args.push({ name: argName, value: this.value() });
        }
      }
      this.directives();
      const selection = this.peek() === '{' ? this.selectionSet() : null;
      selections.push({ kind: 'field', field: { name: fieldName, alias, args, selection } });
    }
    return selections;
  }

  private value(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.name() };
    if (token === '[') {
      const items: Value[] = [];
      while (!this.skip(']')) items.push(this.value());
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.skip('}')) {
        const fieldName = this.name();
        this.expect(':');
        fields.push({ name: fieldName, value: this.value() });
      }
      return { kind: 'object', fields };
    }
    if (typeof token === 'object') return { kind: 'string', value: token.str };
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: token };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: token };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ values

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'int':
      return parseInt(value.value, 10);
    case 'float':
      return parseFloat(value.value);
    case 'string':
    case 'enum':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, vars);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema

interface Ctx {
  forge: Forge;
  vars: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: { message: string }[];
}

type Resolver = (parent: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields?: Record<string, { type: string; resolve: Resolver }>;
  enumValues?: string[];
}

const iso = (epochSec: number): string => new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface Connection<T> {
  __typename: string;
  items: T[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

function connect<T>(typename: string, sorted: T[], args: Record<string, unknown>): Connection<T> {
  const after = decodeCursor(args.after);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : sorted.length;
  const startIndex = after + 1;
  const slice = sorted.slice(startIndex, startIndex + first);
  return {
    __typename: typename,
    items: slice,
    totalCount: sorted.length,
    pageInfo: {
      hasNextPage: startIndex + slice.length < sorted.length,
      hasPreviousPage: startIndex > 0,
      startCursor: slice.length > 0 ? encodeCursor(startIndex) : null,
      endCursor: slice.length > 0 ? encodeCursor(startIndex + slice.length - 1) : null,
    },
  };
}

function sortIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const sorted = [...issues].sort((a, b) => (a.createdSeq - b.createdSeq) || (a.number - b.number));
  if (direction !== 'ASC') sorted.reverse();
  return sorted;
}

/** Filter connection items by their GraphQL state names; the default view is OPEN only. */
function filterStates<T extends { state: string }>(items: T[], args: Record<string, unknown>): T[] {
  const states = args.states;
  if (!Array.isArray(states) || states.length === 0) return items.filter((item) => item.state === 'OPEN');
  const wanted = new Set(states.map((state) => String(state)));
  return items.filter((item) => wanted.has(item.state));
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: {
        type: 'User',
        resolve: () => ({ __typename: 'User' }),
      },
      repository: {
        type: 'Repository',
        resolve: (_parent, args, ctx) => {
          if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
          const repo = ctx.forge.repo(args.name);
          return repo === undefined ? null : { __typename: 'Repository', repo };
        },
      },
      node: {
        type: 'Node',
        resolve: (_parent, args, ctx) => (typeof args.id === 'string' ? lookupNode(ctx.forge, args.id) : null),
      },
      __type: {
        type: '__Type',
        resolve: (_parent, args) => (typeof args.name === 'string' ? typeInfo(args.name) : null),
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ __typename: '__Schema' }),
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(ctx.forge, input.repositoryId);
          if (repo === null) throw new Error('repository not found');
          const created = createIssue(ctx.forge, repo, { title: input.title, body: input.body });
          if (!created.ok) throw new Error(created.message);
          return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue: created.issue }, clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = typeof input.issueId === 'string' ? lookupNode(ctx.forge, input.issueId) : null;
          if (found === null || found.__typename !== 'Issue') throw new Error('issue not found');
          const { repo, issue } = found as { repo: Repo; issue: Issue };
          if (issue.state !== 'closed') {
            issue.state = 'closed';
            issue.closedSeq = ctx.forge.tick();
          }
          return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue }, clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(ctx.forge, input.repositoryId);
          if (repo === null) throw new Error('repository not found');
          const created = createPull(ctx.forge, repo, {
            title: input.title,
            body: input.body,
            head: input.headRefName,
            base: input.baseRefName,
          });
          if (!created.ok) throw new Error(created.message);
          return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: created.pull }, clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = typeof input.pullRequestId === 'string' ? lookupNode(ctx.forge, input.pullRequestId) : null;
          if (found === null || found.__typename !== 'PullRequest') throw new Error('pull request not found');
          const { repo, pull } = found as { repo: Repo; pull: PullRequest };
          const merged = mergePull(ctx.forge, repo, pull);
          if (!merged.ok) throw new Error(merged.message);
          return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull }, clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = typeof input.subjectId === 'string' ? lookupNode(ctx.forge, input.subjectId) : null;
          if (found === null || (found.__typename !== 'Issue' && found.__typename !== 'PullRequest')) throw new Error('subject not found');
          const body = typeof input.body === 'string' ? input.body : '';
          const comment = { id: ctx.forge.nextCommentId(), body, createdSeq: ctx.forge.tick() };
          if (found.__typename === 'Issue') (found as { issue: Issue }).issue.comments.push(comment);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', comment } },
            clientMutationId: input.clientMutationId ?? null,
          };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String', resolve: () => VIEWER.login },
      id: { type: 'ID', resolve: () => Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url') },
      databaseId: { type: 'Int', resolve: () => VIEWER.id },
      name: { type: 'String', resolve: () => VIEWER.name },
      email: { type: 'String', resolve: () => VIEWER.email },
    },
  },
  RepositoryOwner: {
    kind: 'INTERFACE',
    fields: {
      login: { type: 'String', resolve: () => VIEWER.login },
      id: { type: 'ID', resolve: () => Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url') },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (parent) => repoNodeId((parent as { repo: Repo }).repo) },
      databaseId: { type: 'Int', resolve: (parent) => (parent as { repo: Repo }).repo.id },
      name: { type: 'String', resolve: (parent) => (parent as { repo: Repo }).repo.name },
      nameWithOwner: { type: 'String', resolve: (parent) => `${VIEWER.login}/${(parent as { repo: Repo }).repo.name}` },
      description: { type: 'String', resolve: (parent) => (parent as { repo: Repo }).repo.description },
      isPrivate: { type: 'Boolean', resolve: (parent) => (parent as { repo: Repo }).repo.private },
      owner: { type: 'RepositoryOwner', resolve: () => ({ __typename: 'User' }) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (parent) => {
          const repo = (parent as { repo: Repo }).repo;
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
        },
      },
      viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
      createdAt: { type: 'String', resolve: (parent) => iso((parent as { repo: Repo }).repo.createdSeq) },
      issue: {
        type: 'Issue',
        resolve: (parent, args) => {
          const repo = (parent as { repo: Repo }).repo;
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (parent, args) => {
          const repo = (parent as { repo: Repo }).repo;
          const mapped = [...repo.issues.values()].map((issue) => ({ issue, state: issue.state === 'open' ? 'OPEN' : 'CLOSED' }));
          const kept = filterStates(mapped, args).map((entry) => entry.issue);
          const sorted = sortIssues(kept, args);
          return connect('IssueConnection', sorted.map((issue) => ({ __typename: 'Issue', repo, issue })), args);
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (parent, args) => {
          const repo = (parent as { repo: Repo }).repo;
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (parent, args) => {
          const repo = (parent as { repo: Repo }).repo;
          const mapped = [...repo.pulls.values()].map((pull) => ({
            pull,
            state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
          }));
          const filtered = filterStates(mapped, args);
          const sorted = filtered.sort((a, b) => b.pull.number - a.pull.number).map((entry) => entry.pull);
          return connect('PullRequestConnection', sorted.map((pull) => ({ __typename: 'PullRequest', repo, pull })), args);
        },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
      prefix: { type: 'String', resolve: () => 'refs/heads/' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (parent) => issueNodeId((parent as { repo: Repo }).repo, (parent as { issue: Issue }).issue.number) },
      databaseId: { type: 'Int', resolve: (parent) => (parent as { issue: Issue }).issue.id },
      number: { type: 'Int', resolve: (parent) => (parent as { issue: Issue }).issue.number },
      title: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.title },
      body: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.body },
      state: { type: 'IssueState', resolve: (parent) => ((parent as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED') },
      author: { type: 'User', resolve: () => ({ __typename: 'User' }) },
      createdAt: { type: 'String', resolve: (parent) => iso((parent as { issue: Issue }).issue.createdSeq) },
      repository: { type: 'Repository', resolve: (parent) => ({ __typename: 'Repository', repo: (parent as { repo: Repo }).repo }) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (parent) => pullNodeId((parent as { repo: Repo }).repo, (parent as { pull: PullRequest }).pull.number) },
      databaseId: { type: 'Int', resolve: (parent) => (parent as { pull: PullRequest }).pull.id },
      number: { type: 'Int', resolve: (parent) => (parent as { pull: PullRequest }).pull.number },
      title: { type: 'String', resolve: (parent) => (parent as { pull: PullRequest }).pull.title },
      body: { type: 'String', resolve: (parent) => (parent as { pull: PullRequest }).pull.body },
      state: {
        type: 'PullRequestState',
        resolve: (parent) => {
          const pull = (parent as { pull: PullRequest }).pull;
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        },
      },
      merged: { type: 'Boolean', resolve: (parent) => (parent as { pull: PullRequest }).pull.merged },
      mergeable: { type: 'MergeableState', resolve: (parent, _args, ctx) => mergeableState((parent as { repo: Repo }).repo, (parent as { pull: PullRequest }).pull) },
      headRefName: { type: 'String', resolve: (parent) => (parent as { pull: PullRequest }).pull.headRef },
      baseRefName: { type: 'String', resolve: (parent) => (parent as { pull: PullRequest }).pull.baseRef },
      author: { type: 'User', resolve: () => ({ __typename: 'User' }) },
      createdAt: { type: 'String', resolve: (parent) => iso((parent as { pull: PullRequest }).pull.createdSeq) },
      repository: { type: 'Repository', resolve: (parent) => ({ __typename: 'Repository', repo: (parent as { repo: Repo }).repo }) },
      files: {
        type: 'PullRequestFilesConnection',
        resolve: (parent, args) => {
          const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
          const files = pullFiles(repo, pull).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return connect('PullRequestFilesConnection', files, args);
        },
      },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (parent) => (parent as { path: string }).path },
      additions: { type: 'Int', resolve: (parent) => (parent as { additions: number }).additions },
      deletions: { type: 'Int', resolve: (parent) => (parent as { deletions: number }).deletions },
      changeType: { type: 'String', resolve: (parent) => (parent as { changeType: string }).changeType },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (parent) => commentNodeId((parent as { comment: { id: number } }).comment.id) },
      body: { type: 'String', resolve: (parent) => (parent as { comment: { body: string } }).comment.body },
      author: { type: 'User', resolve: () => ({ __typename: 'User' }) },
      createdAt: { type: 'String', resolve: (parent) => iso((parent as { comment: { createdSeq: number } }).comment.createdSeq) },
    },
  },
  IssueConnection: connectionType('Issue'),
  PullRequestConnection: connectionType('PullRequest'),
  PullRequestFilesConnection: connectionType('PullRequestChangedFile'),
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: (parent) => (parent as { node: unknown }).node },
      cursor: { type: 'String', resolve: () => encodeCursor(0) },
    },
  },
  CreateIssuePayload: payloadType('issue', 'Issue'),
  CloseIssuePayload: payloadType('issue', 'Issue'),
  CreatePullRequestPayload: payloadType('pullRequest', 'PullRequest'),
  MergePullRequestPayload: payloadType('pullRequest', 'PullRequest'),
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (parent) => (parent as { commentEdge: unknown }).commentEdge },
      clientMutationId: { type: 'String', resolve: (parent) => (parent as { clientMutationId: unknown }).clientMutationId ?? null },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID', resolve: () => null } } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
      kind: { type: 'String', resolve: (parent) => (parent as { kind: string }).kind },
      fields: {
        type: '[__Field]',
        resolve: (parent) => {
          const def = SCHEMA[(parent as { name: string }).name];
          if (def === undefined || def.fields === undefined) return null;
          return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        resolve: (parent) => {
          const def = SCHEMA[(parent as { name: string }).name];
          if (def === undefined || def.enumValues === undefined) return null;
          return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
        },
      },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: { name: { type: 'String', resolve: (parent) => (parent as { name: string }).name } },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String', resolve: (parent) => (parent as { name: string }).name } },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { type: '__Type', resolve: () => typeInfo('Query') },
      mutationType: { type: '__Type', resolve: () => typeInfo('Mutation') },
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  MergePullRequestMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  FileChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'] },
};

function connectionType(nodeType: string): TypeDef {
  return {
    kind: 'OBJECT',
    fields: {
      nodes: { type: `[${nodeType}]`, resolve: (parent) => (parent as Connection<unknown>).items },
      edges: {
        type: '[__Edge]',
        resolve: (parent) => (parent as Connection<unknown>).items.map((node, index) => ({ __typename: '__Edge', node, cursor: encodeCursor(index) })),
      },
      totalCount: { type: 'Int', resolve: (parent) => (parent as Connection<unknown>).totalCount },
      pageInfo: { type: 'PageInfo', resolve: (parent) => ({ __typename: 'PageInfo', ...(parent as Connection<unknown>).pageInfo }) },
    },
  };
}

function payloadType(field: string, type: string): TypeDef {
  return {
    kind: 'OBJECT',
    fields: {
      [field]: { type, resolve: (parent) => (parent as Record<string, unknown>)[field] },
      clientMutationId: { type: 'String', resolve: (parent) => (parent as { clientMutationId: unknown }).clientMutationId ?? null },
    },
  };
}

// Register the generic edge/page-info types after the literal above (they are structural).
SCHEMA['PageInfo'] = {
  kind: 'OBJECT',
  fields: {
    hasNextPage: { type: 'Boolean', resolve: (parent) => (parent as { hasNextPage: boolean }).hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: (parent) => (parent as { hasPreviousPage: boolean }).hasPreviousPage },
    startCursor: { type: 'String', resolve: (parent) => (parent as { startCursor: string | null }).startCursor },
    endCursor: { type: 'String', resolve: (parent) => (parent as { endCursor: string | null }).endCursor },
  },
};
SCHEMA['__Edge'] = {
  kind: 'OBJECT',
  fields: {
    node: { type: 'Node', resolve: (parent) => (parent as { node: unknown }).node },
    cursor: { type: 'String', resolve: (parent) => (parent as { cursor: string }).cursor },
  },
};

function typeInfo(name: string): { __typename: string; name: string; kind: string } | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return { __typename: '__Type', name, kind: def.kind };
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const wanted = Number(decoded.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function lookupNode(forge: Forge, id: string): Record<string, unknown> | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByGlobalId(forge, id);
    return repo === null ? null : { __typename: 'Repository', repo };
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of forge.repos.values()) {
      if (repo.id !== repoId) continue;
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { __typename: 'Issue', repo, issue };
      }
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
    }
    return null;
  }
  if (decoded.kind === 'IssueComment') {
    const commentId = Number(decoded.parts[0]);
    for (const repo of forge.repos.values()) {
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((candidate) => candidate.id === commentId);
        if (comment !== undefined) return { __typename: 'IssueComment', comment };
      }
    }
    return null;
  }
  if (decoded.kind === 'User') return { __typename: 'User' };
  return null;
}

// ------------------------------------------------------------------ execution

function expandSelections(selections: SelectionNode[], typeName: string, ctx: Ctx): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      fields.push(selection.field);
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        fields.push(...expandSelections(fragment.selection, typeName, ctx));
      }
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        fields.push(...expandSelections(selection.selection, typeName, ctx));
      }
    }
  }
  return fields;
}

function executeSelectionSet(selections: SelectionNode[], typeName: string, parent: any, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName];
  for (const field of expandSelections(selections, typeName, ctx)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = typeDef?.fields?.[field.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.vars);
    try {
      const raw = fieldDef.resolve(parent, args, ctx);
      out[key] = completeValue(fieldDef.type, raw, field.selection, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
    }
  }
  return out;
}

function completeValue(typeRef: string, value: unknown, selection: SelectionNode[] | null, ctx: Ctx): unknown {
  const type = typeRef.replace(/!$/, '');
  if (value === null || value === undefined) return null;
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue(inner, item, selection, ctx));
  }
  const def = SCHEMA[type];
  if (def === undefined || def.kind === 'ENUM') return value;
  if (selection === null) return value;
  const typename = (value as { __typename?: string }).__typename ?? type;
  return executeSelectionSet(selection, typename, value, ctx);
}

export function executeGraphql(forge: Forge, body: unknown): Record<string, unknown> {
  const request = (body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'query is required' }] };
  }
  let document: Document;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  const vars: Record<string, unknown> = {};
  if (request.variables !== null && typeof request.variables === 'object') {
    Object.assign(vars, request.variables as Record<string, unknown>);
  }
  for (const def of operation.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: Ctx = { forge, vars, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selection, rootType, { __typename: rootType }, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
