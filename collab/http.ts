import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { GitError } from './git.js';
import {
  authorizeOperation,
  operationInput,
  requireOperation,
  type DaemonSummary,
  type OperationContext,
  type OperationPrincipal,
  type OutputStream,
  type SessionActivity,
} from './operations.js';
import type { GitRepository } from './git.js';
import { AttachmentError, parseAttachmentInputs, ATTACHMENT_MAX_REQUEST_BYTES } from './attachments.js';
import type { CollaborationService } from './service.js';
import { CollaborationError } from './service.js';
import { emptyRuntimeView, type RuntimeObserver } from './observe.js';

const HUMAN_OPERATIONS = new Set([
  'task.create',
  'task.assign_roles',
  'message.send',
  'task.file.add',
  'check_policy.override',
  'proposal.reveal',
  'decision.accept',
  'task.accept',
  'task.cancel',
]);

const HUMAN_BODY_LIMIT = ATTACHMENT_MAX_REQUEST_BYTES + 32_768;

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
 * `agent` is the local control and bootstrap credential: it establishes and recovers model
 * sessions and carries human authority, and is published in the owner-only daemon descriptor. It
 * no longer represents any model identity. `browser` reaches only the snapshot and the
 * human-control routes, and is delivered through the URL fragment the daemon prints on its own
 * stdout.
 *
 * Model session credentials are deliberately absent here. They are durable, they outlive a daemon
 * start, and they live in the database rather than in this process.
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

/**
 * Per-session view of the same fact `ActivityGate` tracks for the daemon as a whole: work accepted
 * and not yet finished. Recovery consults it so a session that is still writing cannot be replaced.
 */
export function createSessionActivity(): SessionActivity {
  const counts = new Map<string, number>();
  return {
    begin: (sessionId) => { counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1); },
    end: (sessionId) => {
      const remaining = (counts.get(sessionId) ?? 0) - 1;
      if (remaining > 0) counts.set(sessionId, remaining);
      else counts.delete(sessionId);
    },
    busy: (sessionId) => (counts.get(sessionId) ?? 0) > 0,
  };
}

export interface CollaborationHttpOptions {
  service: CollaborationService;
  repository: GitRepository;
  credentials: DaemonCredentials;
  daemon: DaemonSummary;
  activity?: ActivityGate;
  sessionActivity?: SessionActivity;
  observer?: RuntimeObserver;
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

/**
 * Resolves the operation route's bearer credential to an authenticated principal.
 *
 * A durable model session is tried first, so a session credential keeps working across daemon
 * restarts that reminted the control credential. Everything else — missing, unknown, closed, or
 * replaced — falls through to the control comparison and then fails closed.
 */
function requirePrincipal(
  request: IncomingMessage,
  service: CollaborationService,
  credentials: DaemonCredentials,
): OperationPrincipal {
  const presented = presentedCredential(request);
  if (presented) {
    const session = service.authenticateSession(presented);
    if (session) return { kind: 'session', agentId: session.agentId, sessionId: session.sessionId };
    if (credentialMatches(presented, credentials.agent)) return { kind: 'control', agentId: 'human' };
  }
  throw new HttpError('a collabd session or control credential is required', 401, 'unauthorized');
}

async function readJson(request: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new HttpError('request body is too large', 413, 'body_too_large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError('request body must be a JSON object', 400, 'invalid_json');
  }
}

function rejectSpoofedHumanIdentity(input: Record<string, unknown>): void {
  if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'from')) {
    throw new HttpError('the field terminal cannot supply actor identity', 403, 'actor_spoof_rejected');
  }
}

function invokeHumanOperation(service: CollaborationService, operation: string, input: Record<string, unknown>): unknown {
  switch (operation) {
    case 'task.create':
      return service.createTask({
        id: requiredHumanString(input, 'id'),
        goal: requiredHumanString(input, 'goal'),
        acceptance: stringList(input, 'acceptance'),
        actor: 'human',
      });
    case 'task.assign_roles':
      return service.assignTaskRoles({
        taskId: requiredHumanString(input, 'taskId'),
        actor: 'human',
        implementer: requiredHumanString(input, 'implementer'),
        reviewer: requiredHumanString(input, 'reviewer'),
        verifier: requiredHumanString(input, 'verifier'),
      });
    case 'message.send':
      return service.sendMessage({
        from: 'human',
        to: requiredHumanString(input, 'to'),
        taskId: optionalHumanString(input, 'taskId'),
        body: requiredHumanString(input, 'body'),
        files: parseAttachmentInputs(input['files']),
      });
    case 'task.file.add':
      return service.addTaskFiles({
        taskId: requiredHumanString(input, 'taskId'),
        actor: 'human',
        files: parseAttachmentInputs(input['files']),
      });
    case 'check_policy.override':
      return service.overrideCheckPolicy({
        taskId: requiredHumanString(input, 'taskId'),
        actor: 'human',
        reason: requiredHumanString(input, 'reason'),
      });
    case 'proposal.reveal':
      return service.revealProposals(requiredHumanString(input, 'taskId'), 'human');
    case 'decision.accept':
      return service.acceptDecision(requiredHumanString(input, 'decisionId'), 'human');
    case 'task.accept':
      return service.acceptTask({
        taskId: requiredHumanString(input, 'taskId'),
        actor: 'human',
        expectedVersion: requiredHumanInteger(input, 'expectedVersion'),
      });
    case 'task.cancel':
      return service.cancelTask({
        taskId: requiredHumanString(input, 'taskId'),
        actor: 'human',
      });
    default:
      throw new HttpError('operation is not allowed on the field terminal', 403, 'operation_not_allowed');
  }
}

function requiredHumanString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(`${key} must be a non-empty string`, 400, 'invalid_operation_input');
  }
  return value;
}

function optionalHumanString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(`${key} must be a non-empty string`, 400, 'invalid_operation_input');
  }
  return value;
}

function stringList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(`${key} must be an array of strings`, 400, 'invalid_operation_input');
  }
  return value as string[];
}

function requiredHumanInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpError(`${key} must be a non-negative integer`, 400, 'invalid_operation_input');
  }
  return value;
}

function errorStatus(error: { code: string }): number {
  if (error.code.startsWith('unknown_')) return 404;
  if (error.code === 'identity_mismatch') return 403;
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
  context: Omit<OperationContext, 'onOutput' | 'principal'>,
  authenticate: () => OperationPrincipal,
): Promise<void> {
  const body = await readJson(request);
  const name = body['operation'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpError('operation must be a non-empty string', 400, 'invalid_operation');
  }

  /**
   * The authoritative identity decision, taken after the last await and never before it.
   *
   * Reading the body yields to the event loop, and a session can be replaced during that yield. A
   * principal resolved before the yield describes who the caller *was*; only a principal resolved
   * here decides who the caller is allowed to be now. Everything from this point to
   * `sessionActivity.begin()` is synchronous, so a session cannot be replaced between being
   * accepted and being counted as a writer.
   */
  const principal = authenticate();
  const { sessionActivity } = context;

  let definition;
  let input;
  try {
    definition = requireOperation(name);
    input = operationInput(body['input']);
    // The session boundary answers before the stream opens, so a refused identity is an HTTP
    // status rather than an error frame inside a 200 the caller has to parse.
    authorizeOperation(definition, principal, input);
  } catch (error) {
    if (error instanceof CollaborationError) {
      throw new HttpError(error.message, error.code === 'unknown_operation' ? 404 : errorStatus(error), error.code);
    }
    throw error;
  }

  // Any authenticated request from a session is evidence of life; no separate heartbeat is required.
  if (principal.kind === 'session') context.service.touchSession(principal);
  // Only accepted mutations make a session unreplaceable. Reads cannot leave canonical state
  // half-written, and treating them as work in flight would make recovery hostage to polling.
  const tracked = principal.kind === 'session' && definition.mutating;
  // Sampled before this request registers its own activity. An issuing operation is mutating, so it
  // marks its own session busy below and would otherwise always observe itself as work in flight —
  // which would make a busy session indistinguishable from a quiet one at exactly the moment the
  // distinction decides whether a second action may be delivered.
  const sessionWorkInFlight =
    principal.kind === 'session' ? (sessionActivity?.busy(principal.sessionId) ?? false) : undefined;
  if (tracked) sessionActivity?.begin(principal.sessionId);

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
    write({
      type: 'result',
      value: await definition.invoke({ ...context, principal, sessionWorkInFlight, onOutput }, input),
    });
  } catch (error) {
    if (error instanceof CollaborationError || error instanceof GitError) {
      write({ type: 'error', code: error.code, message: error.message });
    } else {
      console.error(error);
      write({ type: 'error', code: 'internal_error', message: 'internal server error' });
    }
  } finally {
    if (tracked && principal.kind === 'session') sessionActivity?.end(principal.sessionId);
    clearInterval(keepalive);
    response.end();
  }
}

export function createCollaborationHttpServer(options: CollaborationHttpOptions) {
  const { service, repository, credentials, daemon, activity, sessionActivity, observer, staticRoot } = options;
  const fieldSnapshot = () => {
    const view = observer?.tick() ?? emptyRuntimeView();
    return { ...service.snapshot(), runtimes: view.runtimes, runtime_events: view.events };
  };
  return createServer(async (request, response) => {
    activity?.begin();
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        requireCredential(request, credentials.browser, 'field terminal');
        return json(response, 200, fieldSnapshot());
      }

      if (request.method === 'GET' && url.pathname === '/api/runtime') {
        requireCredential(request, credentials.browser, 'field terminal');
        const view = observer?.tick() ?? emptyRuntimeView();
        const after = Number(url.searchParams.get('after') ?? '0');
        const events = Number.isInteger(after) && after > 0 ? observer?.eventsAfter(after) ?? view.events : view.events;
        return json(response, 200, { runtimes: view.runtimes, events, cursor: view.cursor });
      }

      const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === 'GET' && attachmentMatch) {
        requireCredential(request, credentials.browser, 'field terminal');
        return json(response, 200, service.getAttachment(decodeURIComponent(attachmentMatch[1] ?? '')));
      }

      if (request.method === 'POST') {
        if (url.pathname === '/api/human') {
          requireCredential(request, credentials.browser, 'field terminal');
          requireSameOrigin(request);
          const body = await readJson(request, HUMAN_BODY_LIMIT);
          const operation = body['operation'];
          if (typeof operation !== 'string' || operation.length === 0) {
            throw new HttpError('operation must be a non-empty string', 400, 'invalid_operation');
          }
          if (!HUMAN_OPERATIONS.has(operation)) {
            throw new HttpError('operation is not allowed on the field terminal', 403, 'operation_not_allowed');
          }
          const input = operationInput(body['input']);
          rejectSpoofedHumanIdentity(input);
          try {
            invokeHumanOperation(service, operation, input);
          } catch (error) {
            if (error instanceof AttachmentError) {
              throw new CollaborationError(error.message, error.code);
            }
            throw error;
          }
          return json(response, 200, fieldSnapshot());
        }

        if (url.pathname === '/api/operations') {
          const authenticate = (): OperationPrincipal => requirePrincipal(request, service, credentials);
          // Fail fast on a credential that is already worthless, so an unauthenticated caller is
          // never invited to upload a body. This is a cheap pre-check, not the authoritative one:
          // `streamOperation` re-resolves the principal after the body has been read.
          authenticate();
          rejectForeignOrigin(request);
          return await streamOperation(
            request,
            response,
            { service, repository, daemon, sessionActivity },
            authenticate,
          );
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
          return json(response, 200, fieldSnapshot());
        }
        if (decisionMatch) {
          service.acceptDecision(decodeURIComponent(decisionMatch[1] ?? ''), 'human');
          return json(response, 200, fieldSnapshot());
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
          return json(response, 200, fieldSnapshot());
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
      if (error instanceof CollaborationError || error instanceof GitError || error instanceof AttachmentError) {
        return json(response, errorStatus(error), { error: error.message, code: error.code });
      }
      console.error(error);
      return json(response, 500, { error: 'internal server error', code: 'internal_error' });
    } finally {
      activity?.end();
    }
  });
}
