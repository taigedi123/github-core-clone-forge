// The MCP surface at /mcp: JSON-RPC 2.0 tool calls over the same forge the REST and
// GraphQL surfaces serve. It speaks the current protocol era (server/discover) and the
// legacy initialize handshake, and its tool list is a frozen constant so two tools/list
// calls always answer byte-identically.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './domain.ts';
import { Forge, VIEWER, type Repo } from './store.ts';
import { readBody, sendJson } from './web.ts';

const SERVER_INFO = { name: 'silver-kestrel-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => { ok: true; value: unknown } | { ok: false; message: string };
}

function stringProps(names: string[]): Record<string, { type: string }> {
  const out: Record<string, { type: string }> = {};
  for (const name of names) out[name] = { type: 'string' };
  return out;
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | { error: string } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return { error: 'repository not found' };
  const repo = forge.repo(name);
  return repo === undefined ? { error: 'repository not found' } : repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { ...stringProps(['name', 'description']), private: { type: 'boolean' } },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === '') return { ok: false, message: 'name is required' };
      if (forge.repo(name) !== undefined) return { ok: false, message: 'name already exists on this account' };
      const repo = forge.createRepo(name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return { ok: true, value: repoJson(repo) };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: stringProps(['owner', 'repo']), required: ['owner', 'repo'] },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      return { ok: true, value: repoJson(found) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: stringProps(['owner', 'repo', 'title', 'body']),
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const created = createIssue(forge, found, { title: args.title, body: args.body });
      if (!created.ok) return { ok: false, message: created.message };
      return { ok: true, value: issueJson(found, created.issue) };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: stringProps(['owner', 'repo', 'state']),
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...found.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(found, issue));
      return { ok: true, value: issues };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: { ...stringProps(['owner', 'repo']), issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = found.issues.get(number);
      if (issue === undefined) return { ok: false, message: 'issue not found' };
      return { ok: true, value: issueJson(found, issue) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: stringProps(['owner', 'repo', 'title', 'head', 'base', 'body']),
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const created = createPull(forge, found, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (!created.ok) return { ok: false, message: created.message };
      return { ok: true, value: pullJson(forge, found, created.pull) };
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: stringProps(['owner', 'repo', 'state']),
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...found.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(forge, found, pull));
      return { ok: true, value: pulls };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: { ...stringProps(['owner', 'repo']), pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const found = findRepo(forge, args);
      if ('error' in found) return { ok: false, message: found.error };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = found.pulls.get(number);
      if (pull === undefined) return { ok: false, message: 'pull request not found' };
      const merged = mergePull(forge, found, pull);
      if (!merged.ok) return { ok: false, message: merged.message };
      return { ok: true, value: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(forge: Forge, params: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { error: { code: -32602, message: `missing required argument: ${key}` } };
    }
  }
  const outcome = tool.run(forge, args);
  if (!outcome.ok) {
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify({ message: outcome.message }) }],
        isError: true,
      },
    };
  }
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
      isError: false,
    },
  };
}

function handleMessage(forge: Forge, message: RpcMessage): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = message.id !== undefined && message.id !== null;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (method.startsWith('notifications/')) {
    return null; // A notification: no reply, whatever its name.
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(message.id, {
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        supportedVersions: SUPPORTED_VERSIONS,
      });
    case 'initialize':
      return rpcResult(message.id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, { tools: TOOL_LIST });
    case 'tools/call': {
      const outcome = callTool(forge, params);
      if (outcome.error !== undefined) return rpcError(message.id, outcome.error.code, outcome.error.message);
      return rpcResult(message.id, outcome.result);
    }
    case 'resources/list':
      return rpcResult(message.id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(message.id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(message.id, { prompts: [] });
    default:
      if (!hasId) return null;
      return rpcError(message.id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (Array.isArray(parsed)) {
    const replies: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const reply = handleMessage(forge, (entry ?? {}) as RpcMessage);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, replies);
    return;
  }
  const reply = handleMessage(forge, (parsed ?? {}) as RpcMessage);
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, reply);
}
