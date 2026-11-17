// The forge application: one HTTP server routing every surface — the boot health
// probe, git smart HTTP, the REST v3 API, GraphQL and MCP. Every surface except the
// health probe requires the trial's bearer token; the check is identical everywhere.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGit, isGitPath } from './githttp.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';
import { parseJsonBody, readBody, sendError, sendJson } from './web.ts';

/** Build the forge's HTTP server (not yet listening); the entry binds the port. */
export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req, res) => {
    void route(forge, expectedToken, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error');
      } else {
        res.end();
      }
    });
  });
}

async function route(forge: Forge, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;

  // The boot probe answers without auth so the harness can find the port.
  if (path === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // One credential for every surface: the bearer token the environment handed us.
  const presented = req.headers.authorization ?? '';
  if (expectedToken === '' || presented !== `Bearer ${expectedToken}`) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  if (isGitPath(path)) {
    await handleGit(forge, req, res, url);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(forge, req, res);
    return;
  }
  if (path === '/api/graphql' && req.method === 'POST') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed.value)) {
      sendJson(res, 200, parsed.value.map((entry) => executeGraphql(forge, entry)));
      return;
    }
    sendJson(res, 200, executeGraphql(forge, parsed.value));
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(forge, req, res, url);
    return;
  }
  sendError(res, 404, 'Not Found');
}
