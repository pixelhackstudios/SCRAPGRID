import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { CollaborationService } from './service.js';
import { CollaborationError } from './service.js';
import { GitError } from './git.js';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function requireSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  if (!host || new URL(origin).host !== host) {
    throw new HttpError('cross-origin mutation rejected', 403, 'origin_rejected');
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new HttpError('request body is too large', 413, 'body_too_large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError('request body must be a JSON object', 400, 'invalid_json');
  }
}

function errorStatus(error: CollaborationError | GitError): number {
  if (error.code.startsWith('unknown_')) return 404;
  if (error.code.includes('required') || error.code.includes('forbidden')) return 403;
  return 409;
}

async function serveStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const requestedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const root = resolve(staticRoot);
  const filePath = resolve(root, requestedPath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new HttpError('not found', 404, 'not_found');
  }
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, {
      'cache-control': pathname === '/' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(contents);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !extname(pathname)) return serveStatic(response, staticRoot, '/');
    if (code === 'ENOENT') throw new HttpError('not found', 404, 'not_found');
    throw error;
  }
}

export function createCollaborationHttpServer(service: CollaborationService, staticRoot?: string) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        return json(response, 200, service.snapshot());
      }

      if (request.method === 'POST') {
        requireSameOrigin(request);
        const revealMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reveal-proposals$/);
        if (revealMatch) {
          service.revealProposals(decodeURIComponent(revealMatch[1] ?? ''), 'human');
          return json(response, 200, service.snapshot());
        }
        const decisionMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)\/accept$/);
        if (decisionMatch) {
          service.acceptDecision(decodeURIComponent(decisionMatch[1] ?? ''), 'human');
          return json(response, 200, service.snapshot());
        }
        const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/accept$/);
        if (taskMatch) {
          const body = await readJson(request);
          const expectedVersion = body['expected_version'];
          if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0) {
            throw new HttpError('expected_version must be a non-negative integer', 400, 'invalid_expected_version');
          }
          service.acceptTask({
            taskId: decodeURIComponent(taskMatch[1] ?? ''),
            actor: 'human',
            expectedVersion: Number(expectedVersion),
          });
          return json(response, 200, service.snapshot());
        }
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError('not found', 404, 'not_found');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError('method not allowed', 405, 'method_not_allowed');
      }
      if (!staticRoot) throw new HttpError('not found', 404, 'not_found');
      return await serveStatic(response, staticRoot, url.pathname);
    } catch (error) {
      if (error instanceof HttpError) return json(response, error.status, { error: error.message, code: error.code });
      if (error instanceof CollaborationError || error instanceof GitError) {
        return json(response, errorStatus(error), { error: error.message, code: error.code });
      }
      console.error(error);
      return json(response, 500, { error: 'internal server error', code: 'internal_error' });
    }
  });
}
