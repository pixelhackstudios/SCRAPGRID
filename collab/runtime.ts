import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultDatabasePath } from './database.js';
import { SCHEMA_VERSION } from './schema.js';

export class DaemonRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DaemonRuntimeError';
  }
}

/**
 * Written by `collabd` so clients can find it. The browser token is deliberately absent here:
 * it lives only in the owner-only field-terminal sidecar and the daemon's own stdout.
 */
export interface DaemonDescriptor {
  url: string;
  pid: number;
  repository_identity: string;
  schema_version: number;
  agent_token: string;
  started_at: string;
}

/**
 * A model's answer to "who am I?", written into its own managed worktree.
 *
 * The daemon descriptor answers "where is collabd?" and is reminted on every start. Keeping the two
 * apart is what lets the daemon's port, pid, and control credential rotate without destroying a
 * model's collaboration identity.
 */
export interface SessionDescriptor {
  session_id: string;
  agent_id: string;
  token: string;
  issued_at: string;
}

/** A session credential lives beside the worktree's other local collaboration state. */
export function sessionDescriptorPath(worktreePath: string): string {
  return resolve(worktreePath, '.collab/session.json');
}

export function writeSessionDescriptor(path: string, descriptor: SessionDescriptor): void {
  mkdirSync(dirname(path), { recursive: true });
  // Remove first so the owner-only mode applies even when a previous session file is present.
  rmSync(path, { force: true });
  const handle = openSync(path, 'wx', 0o600);
  try {
    writeSync(handle, `${JSON.stringify(descriptor, null, 2)}\n`);
  } finally {
    closeSync(handle);
  }
}

export function readSessionDescriptor(path: string): SessionDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new DaemonRuntimeError(`${path} is not a readable session descriptor`, 'invalid_session_descriptor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DaemonRuntimeError(`${path} must contain an object`, 'invalid_session_descriptor');
  }
  const candidate = parsed as Record<string, unknown>;
  const sessionId = candidate['session_id'];
  const agentId = candidate['agent_id'];
  const token = candidate['token'];
  const issuedAt = candidate['issued_at'];
  if (
    typeof sessionId !== 'string' ||
    typeof agentId !== 'string' ||
    typeof token !== 'string' ||
    typeof issuedAt !== 'string'
  ) {
    throw new DaemonRuntimeError(`${path} is missing required session fields`, 'invalid_session_descriptor');
  }
  return { session_id: sessionId, agent_id: agentId, token, issued_at: issuedAt };
}

export interface DaemonLock {
  readonly path: string;
  release(): void;
}

export interface FieldTerminalSidecar {
  url: string;
  token: string;
  pid: number;
  repository_identity: string;
  started_at: string;
}

export interface DaemonRuntimePaths {
  directory: string;
  lockPath: string;
  descriptorPath: string;
  fieldTerminalPath: string;
}

/**
 * Runtime files live beside the collaboration database, so `COLLAB_DB` keeps them together.
 */
export function daemonRuntimePaths(repositoryRoot: string, databasePath = defaultDatabasePath(repositoryRoot)): DaemonRuntimePaths {
  const directory = dirname(databasePath);
  return {
    directory,
    lockPath: resolve(directory, 'collabd.lock'),
    descriptorPath: resolve(directory, 'collabd.json'),
    fieldTerminalPath: resolve(directory, 'field-terminal.json'),
  };
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryCreateExclusive(path: string): number | null {
  try {
    return openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}

function readLockOwner(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Establishes singleton daemon ownership. A lock whose recorded pid is gone is treated as the
 * residue of a crash and taken over; a lock whose owner is alive fails closed.
 */
export function acquireDaemonLock(lockPath: string): DaemonLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  let handle = tryCreateExclusive(lockPath);
  if (handle === null) {
    const owner = readLockOwner(lockPath);
    if (owner !== null && isProcessAlive(owner)) {
      throw new DaemonRuntimeError(
        `collabd is already running for this repository (pid ${owner})`,
        'daemon_already_running',
      );
    }
    rmSync(lockPath, { force: true });
    handle = tryCreateExclusive(lockPath);
    if (handle === null) {
      throw new DaemonRuntimeError(
        'another collabd claimed the lock while recovering a stale one',
        'daemon_already_running',
      );
    }
  }
  writeSync(handle, `${process.pid}\n`);
  closeSync(handle);

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}

export function writeDaemonDescriptor(descriptorPath: string, descriptor: DaemonDescriptor): void {
  mkdirSync(dirname(descriptorPath), { recursive: true });
  // Remove first so the owner-only mode applies even when a stale descriptor is present.
  rmSync(descriptorPath, { force: true });
  const handle = openSync(descriptorPath, 'wx', 0o600);
  try {
    writeSync(handle, `${JSON.stringify(descriptor, null, 2)}\n`);
  } finally {
    closeSync(handle);
  }
}

export function removeDaemonDescriptor(descriptorPath: string): void {
  rmSync(descriptorPath, { force: true });
}

function writeOwnerOnlyJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const handle = openSync(path, 'wx', 0o600);
  try {
    writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(handle);
  }
}

export function writeFieldTerminalSidecar(path: string, sidecar: FieldTerminalSidecar): void {
  writeOwnerOnlyJson(path, sidecar);
}

export function removeFieldTerminalSidecar(path: string): void {
  rmSync(path, { force: true });
}

export function readFieldTerminalSidecar(path: string): FieldTerminalSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new DaemonRuntimeError(
      `${path} is not a readable field-terminal sidecar`,
      'invalid_field_terminal_sidecar',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DaemonRuntimeError(`${path} must contain an object`, 'invalid_field_terminal_sidecar');
  }
  const candidate = parsed as Record<string, unknown>;
  const url = candidate['url'];
  const token = candidate['token'];
  const pid = candidate['pid'];
  const repositoryIdentity = candidate['repository_identity'];
  const startedAt = candidate['started_at'];
  if (
    typeof url !== 'string' ||
    typeof token !== 'string' ||
    typeof repositoryIdentity !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof pid !== 'number'
  ) {
    throw new DaemonRuntimeError(`${path} is missing required field-terminal fields`, 'invalid_field_terminal_sidecar');
  }
  return { url, token, pid, repository_identity: repositoryIdentity, started_at: startedAt };
}

function descriptorField(value: Record<string, unknown>, key: keyof DaemonDescriptor): unknown {
  return value[key];
}

/**
 * Reads and validates the descriptor a client found on disk. Every failure is closed: a client
 * never falls back to opening the collaboration database itself.
 */
export function readDaemonDescriptor(descriptorPath: string): DaemonDescriptor {
  let contents: string;
  try {
    contents = readFileSync(descriptorPath, 'utf8');
  } catch {
    throw new DaemonRuntimeError(
      `collabd is not running for this repository: ${descriptorPath} is missing`,
      'daemon_unavailable',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new DaemonRuntimeError(`${descriptorPath} is not valid JSON`, 'invalid_daemon_descriptor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DaemonRuntimeError(`${descriptorPath} must contain an object`, 'invalid_daemon_descriptor');
  }
  const candidate = parsed as Record<string, unknown>;
  const url = descriptorField(candidate, 'url');
  const pid = descriptorField(candidate, 'pid');
  const repositoryIdentity = descriptorField(candidate, 'repository_identity');
  const schemaVersion = descriptorField(candidate, 'schema_version');
  const agentToken = descriptorField(candidate, 'agent_token');
  const startedAt = descriptorField(candidate, 'started_at');
  if (
    typeof url !== 'string' ||
    typeof repositoryIdentity !== 'string' ||
    typeof agentToken !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof pid !== 'number' ||
    typeof schemaVersion !== 'number'
  ) {
    throw new DaemonRuntimeError(`${descriptorPath} is missing required daemon fields`, 'invalid_daemon_descriptor');
  }
  return {
    url,
    pid,
    repository_identity: repositoryIdentity,
    schema_version: schemaVersion,
    agent_token: agentToken,
    started_at: startedAt,
  };
}

/**
 * Fails closed when the descriptor describes a dead daemon, another repository, or a schema this
 * client does not understand.
 */
export function requireLiveDaemon(descriptor: DaemonDescriptor, repositoryIdentity: string): DaemonDescriptor {
  if (descriptor.repository_identity !== repositoryIdentity) {
    throw new DaemonRuntimeError(
      `collabd at ${descriptor.url} is bound to a different repository`,
      'daemon_repository_mismatch',
    );
  }
  if (!isProcessAlive(descriptor.pid)) {
    throw new DaemonRuntimeError(
      `collabd is not running: recorded pid ${descriptor.pid} is gone`,
      'daemon_unavailable',
    );
  }
  if (descriptor.schema_version !== SCHEMA_VERSION) {
    throw new DaemonRuntimeError(
      `collabd serves schema ${descriptor.schema_version}, this client expects ${SCHEMA_VERSION}`,
      'daemon_schema_mismatch',
    );
  }
  return descriptor;
}
