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
 * Written by `collabd` so clients can find it. The browser token is deliberately absent: it is
 * printed on the daemon's own stdout and never touches the filesystem.
 */
export interface DaemonDescriptor {
  url: string;
  pid: number;
  repository_identity: string;
  schema_version: number;
  agent_token: string;
  started_at: string;
}

export interface DaemonLock {
  readonly path: string;
  release(): void;
}

export interface DaemonRuntimePaths {
  directory: string;
  lockPath: string;
  descriptorPath: string;
}

/**
 * Runtime files live beside the collaboration database, so `COLLAB_DB` keeps them together.
 */
export function daemonRuntimePaths(repositoryRoot: string): DaemonRuntimePaths {
  const directory = dirname(defaultDatabasePath(repositoryRoot));
  return {
    directory,
    lockPath: resolve(directory, 'collabd.lock'),
    descriptorPath: resolve(directory, 'collabd.json'),
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
