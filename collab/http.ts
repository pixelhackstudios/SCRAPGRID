import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { GitError } from './git.js';
import {
  operationInput,
  requireOperation,
  type DaemonSummary,
  type OperationContext,
  type OutputStream,
} from './operations.js';
import type { GitRepository } from './git.js';
import type { CollaborationService } from './service.js';
import { CollaborationError } from './service.js';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * Two separately scoped credentials, minted fresh by each `collabd` start.
 *
 * `agent` reaches the whole operation registry and is published in the owner-only daemon
 * descriptor. `browser` reaches only the snapshot and the human-control routes, and is delivered
 * through the URL fragment the daemon prints on its own stdout.
 */
export interface DaemonCredentials {
  agent: string;
  browser: string;
}

/**
 * Counts work the daemon has accepted but not finished.
 *
 * Shutdown has to outlast this, not merely outlast the socket: a client can disconnect mid-check
 * while the operation keeps running, and the daemon is still a writer until it returns.
 */
export interface ActivityGate {
  begin(): void;
  end(): void;
  active(): number;
  whenIdle(): Promise<void>;
}

export function createActivityGate(): ActivityGate {
  let active = 0;
  let idleWaiters: Array<() => void> = [];
  return {
    begin: () => { active += 1; },
    end: () => {
      active -= 1;
      if (active > 0) return;
      const waiting = idleWaiters;
      idleWaiters = [];
      for (const notify of waiting) notify();
    },
    active: () => active,
    whenIdle: () =>
      active === 0 ? Promise.resolve() : new Promise<void>((notify) => { idleWaiters.push(notify); }),
  };
}

export interface CollaborationHttpOptions {
  service: CollaborationService;
  repository: GitRepository;
  credentials: DaemonCredentials;
  daemon: DaemonSummary;
  activity?: ActivityGate;
  staticRoot?: string;
}

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

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Browser mutation routes: a missing `Origin` is rejected rather than waved through. */
function requireSameOrigin(request: IncomingMessage): void {
  if (!sameOrigin(request)) {
    throw new HttpError('cross-origin mutation rejected', 403, 'origin_rejected');
  }
}

/**
 * Operation route: the CLI is not a browser and sends no `Origin`, but any request that does
 * present one must present a matching one.
 */
function rejectForeignOrigin(request: IncomingMessage): void {
  if (request.headers.origin !== undefined && !sameOrigin(request)) {
    throw new HttpError('cross-origin mutation rejected', 403, 'origin_rejected');
  }
}

function presentedCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function credentialMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireCredential(request: IncomingMessage, expected: string, scope: string): void {
  const presented = presentedCredential(request);
  if (!presented || !credentialMatches(presented, expected)) {
    throw new HttpError(`a ${scope} credential is required`, 401, 'unauthorized');
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

/**
 * Runs one operation and answers with a newline-delimited JSON stream.
 *
 * Every operation uses the same framing so the client has one code path, and so a long check keeps
 * the response alive: headers flush before the command starts, output frames arrive as the command
 * produces them, and keepalive frames cover silent stretches.
 */
async function streamOperation(
  request: IncomingMessage,
  response: ServerResponse,
  context: Omit<OperationContext, 'onOutput'>,
): Promise<void> {
  const body = await readJson(request);
  const name = body['operation'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpError('operation must be a non-empty string', 400, 'invalid_operation');
  }
  let definition;
  let input;
  try {
    definition = requireOperation(name);
    input = operationInput(body['input']);
  } catch (error) {
    if (error instanceof CollaborationError) {
      throw new HttpError(error.message, error.code === 'unknown_operation' ? 404 : 400, error.code);
    }
    throw error;
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/x-ndjson; charset=utf-8',
  });
  const write = (frame: Record<string, unknown>): void => {
    if (!response.writableEnded) response.write(`${JSON.stringify(frame)}\n`);
  };
  const keepalive = setInterval(() => write({ type: 'keepalive' }), KEEPALIVE_INTERVAL_MS);
  keepalive.unref();
  try {
    const onOutput = (stream: OutputStream, data: string): void => write({ type: 'output', stream, data });
    write({ type: 'result', value: await definition.invoke({ ...context, onOutput }, input) });
  } catch (error) {
    if (error instanceof CollaborationError || error instanceof GitError) {
      write({ type: 'error', code: error.code, message: error.message });
    } else {
      console.error(error);
      write({ type: 'error', code: 'internal_error', message: 'internal server error' });
    }
  } finally {
    clearInterval(keepalive);
    response.end();
  }
}

export function createCollaborationHttpServer(options: CollaborationHttpOptions) {
  const { service, repository, credentials, daemon, activity, staticRoot } = options;
  return createServer(async (request, response) => {
    activity?.begin();
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        requireCredential(request, credentials.browser, 'field terminal');
        return json(response, 200, service.snapshot());
      }

      if (request.method === 'POST') {
        if (url.pathname === '/api/operations') {
          requireCredential(request, credentials.agent, 'collabd agent');
          rejectForeignOrigin(request);
          return await streamOperation(request, response, { service, repository, daemon });
        }

        const revealMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reveal-proposals$/);
        const decisionMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)\/accept$/);
        const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/accept$/);
        if (revealMatch || decisionMatch || taskMatch) {
          // Authenticate before applying the cross-origin guard, so an uncredentialed request is
          // always a 401 no matter what Origin it does or does not present.
          requireCredential(request, credentials.browser, 'field terminal');
          requireSameOrigin(request);
        }
        if (revealMatch) {
          service.revealProposals(decodeURIComponent(revealMatch[1] ?? ''), 'human');
          return json(response, 200, service.snapshot());
        }
        if (decisionMatch) {
          service.acceptDecision(decodeURIComponent(decisionMatch[1] ?? ''), 'human');
          return json(response, 200, service.snapshot());
        }
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
      if (response.headersSent) {
        console.error(error);
        return response.end();
      }
      if (error instanceof HttpError) return json(response, error.status, { error: error.message, code: error.code });
      if (error instanceof CollaborationError || error instanceof GitError) {
        return json(response, errorStatus(error), { error: error.message, code: error.code });
      }
      console.error(error);
      return json(response, 500, { error: 'internal server error', code: 'internal_error' });
    } finally {
      activity?.end();
    }
  });
}
