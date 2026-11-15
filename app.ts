// app.ts — one HTTP server: routing, Bearer auth, the X-GitHub-Request-Id
// header on every reply, and JSON bodies everywhere (never HTML, never a
// crash). The surfaces live in their own modules: githttp (smart HTTP),
// rest (REST v3), graphql (GraphQL v4) and mcp (Model Context Protocol).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './githttp.ts';
import { decodeSegment, errResp, jsonResp, splitPath, type ReqCtx, type Resp } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCount = 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      try {
        send(res, errResp(500, err instanceof Error ? err.message : 'Internal Server Error'), nextRequestId());
      } catch {
        res.destroy();
      }
    });
  });

  function nextRequestId(): string {
    requestCount += 1;
    return `req-${requestCount}`;
  }

  function send(res: ServerResponse, response: Resp, requestId: string): void {
    res.writeHead(response.status, {
      'content-type': response.contentType,
      'content-length': response.body.length,
      'x-github-request-id': requestId,
      ...(response.extraHeaders ?? {}),
    });
    res.end(response.body);
  }

  /** The Authorization header carries the shop token for this trial. */
  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length).trim();
    if (presented === '') return false;
    if (token === '') return true; // No token configured (local runs): any Bearer token passes.
    return presented === token;
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    // Most requests (every GET, and the git advertisements) carry no body:
    // skip the async-iterator machinery entirely for those — it is a
    // measurable fraction of per-request CPU on this hot path.
    const contentLength = req.headers['content-length'];
    const transferEncoding = req.headers['transfer-encoding'];
    if (transferEncoding === undefined && (contentLength === undefined || contentLength === '0')) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_BODY_BYTES) throw new Error('Request body too large');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  function buildCtx(req: IncomingMessage, rawPath: string, rawBody: Buffer): ReqCtx {
    const url = new URL(rawPath, 'http://localhost');
    // Only the headers the handlers actually read.
    const headers: Record<string, string | undefined> = {
      'git-protocol': req.headers['git-protocol'],
      'content-type': req.headers['content-type'],
      host: req.headers.host,
    };
    const contentType = headers['content-type'] ?? '';
    let body: unknown;
    let bodyParseError = false;
    if (rawBody.length > 0 && contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        bodyParseError = true;
      }
    }
    return {
      method: req.method ?? 'GET',
      path: url.pathname,
      segments: splitPath(url.pathname),
      query: url.searchParams,
      headers,
      rawBody,
      body,
      bodyParseError,
      host: headers.host ?? 'localhost',
    };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = nextRequestId();
    const rawUrl = req.url ?? '/';
    const rawPath = rawUrl.split('?')[0] ?? '/';
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch {
      send(res, errResp(413, 'Request body too large'), requestId);
      return;
    }
    const ctx = buildCtx(req, rawUrl, rawBody);
    const path = ctx.path;

    // Health probe: no auth, JSON.
    if (path === '/healthz') {
      send(res, jsonResp(200, { ok: true }), requestId);
      return;
    }

    // Git smart HTTP: no auth, raw binary bodies.
    if (path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack')) {
      const gitReq: GitRequest = { method: ctx.method, path, query: ctx.query, headers: ctx.headers, body: rawBody };
      let response: Resp;
      if (path.endsWith('/info/refs')) response = handleInfoRefs(store, gitReq);
      else if (path.endsWith('/git-upload-pack')) response = handleUploadPack(store, gitReq);
      else response = handleReceivePack(store, gitReq);
      send(res, response, requestId);
      return;
    }
    if (/\.git(\/|$)/.test(path)) {
      send(res, errResp(404, 'Not Found'), requestId);
      return;
    }

    // REST v3: auth on everything except the public root and meta reads.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const publicRead = ctx.method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
      if (!publicRead && !authorized(req)) {
        send(res, errResp(401, 'Bad credentials'), requestId);
        return;
      }
      const response = handleRest(store, ctx);
      send(res, response ?? errResp(404, 'Not Found'), requestId);
      return;
    }

    // GraphQL v4: POST only, auth required.
    if (path === '/api/graphql') {
      if (ctx.method !== 'POST') {
        send(res, errResp(405, 'Method Not Allowed'), requestId);
        return;
      }
      if (!authorized(req)) {
        send(res, errResp(401, 'Bad credentials'), requestId);
        return;
      }
      send(res, handleGraphql(store, ctx), requestId);
      return;
    }

    // MCP: POST only, auth required.
    if (path === '/mcp') {
      if (ctx.method !== 'POST') {
        send(res, errResp(405, 'Method Not Allowed'), requestId);
        return;
      }
      if (!authorized(req)) {
        send(res, errResp(401, 'Bad credentials'), requestId);
        return;
      }
      send(res, handleMcp(store, ctx), requestId);
      return;
    }

    send(res, errResp(404, 'Not Found'), requestId);
  }

  return server;
}

export { decodeSegment };
