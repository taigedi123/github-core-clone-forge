// Small HTTP plumbing shared by every surface: request ids, JSON replies, body reads.

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestSeq = 0;

/** The next X-GitHub-Request-Id value: a counter, so replays stay byte-identical. */
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36).padStart(6, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(value) ?? 'null';
  sendRawJson(res, status, body, extraHeaders);
}

/** Send an already-serialized JSON body (the bytes are the caller's, unchanged). */
export function sendRawJson(res: ServerResponse, status: number, body: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // A connection dropped mid-body never emits 'end': settle instead of hanging.
    // (For a complete message 'close' follows 'end', so the resolve above already won.)
    req.on('close', () => reject(new Error('request closed before its body completed')));
  });
}

/** Parse a JSON request body; { ok: false } for malformed JSON (the 400 path). */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pagination per the GitHub contract: page/per_page query parameters, and a Link header
 * whose rel="next" URL is absolute and same-origin when more pages remain.
 */
export function paginate<T>(items: readonly T[], url: URL, req: IncomingMessage): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}
