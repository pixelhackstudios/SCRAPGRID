#!/usr/bin/env node

import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DatabaseError,
  defaultDatabasePath,
  initializeDatabase,
  openDatabase,
  recoverAbandonedOperations,
} from './database.js';
import { GitError, GitRepository } from './git.js';
import { createActivityGate, createCollaborationHttpServer, createSessionActivity } from './http.js';
import type { DaemonSummary } from './operations.js';
import {
  acquireDaemonLock,
  daemonRuntimePaths,
  DaemonRuntimeError,
  mintToken,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
} from './runtime.js';
import { SCHEMA_VERSION } from './schema.js';
import { CollaborationService, SESSION_STALE_AFTER_MS } from './service.js';

const HOST = '127.0.0.1';

/**
 * How long a session may go quiet before recovery may replace it. Configurable because the right
 * answer depends on how long a model's turns actually run; the default suits frontier coding agents.
 */
function sessionStaleAfterMs(): number {
  const raw = process.env['COLLAB_SESSION_STALE_MS'];
  if (raw === undefined) return SESSION_STALE_AFTER_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new DaemonRuntimeError('COLLAB_SESSION_STALE_MS must be a non-negative integer', 'invalid_session_stale_ms');
  }
  return value;
}

function requestedPort(): number {
  const port = Number(process.env['PORT'] ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DaemonRuntimeError('PORT must be an integer from 0 to 65535', 'invalid_port');
  }
  return port;
}

async function start(): Promise<void> {
  const repository = GitRepository.discover(process.env['COLLAB_REPO']);
  const paths = daemonRuntimePaths(repository.binding.rootPath);

  // Ownership first: nothing opens the database until this process is the only writer.
  const lock = acquireDaemonLock(paths.lockPath);

  let db;
  try {
    db = openDatabase(defaultDatabasePath(repository.binding.rootPath));
    initializeDatabase(db, repository.binding, repository.headCommit());
  } catch (error) {
    lock.release();
    throw error;
  }

  const abandoned = recoverAbandonedOperations(db);
  const activity = createActivityGate();
  const sessionActivity = createSessionActivity();
  const service = new CollaborationService(db, repository, {
    sessionStaleAfterMs: sessionStaleAfterMs(),
    hasWorkInFlight: (sessionId) => sessionActivity.busy(sessionId),
  });
  const credentials = { agent: mintToken(), browser: mintToken() };
  const startedAt = new Date().toISOString();
  const daemon: DaemonSummary = {
    url: '',
    pid: process.pid,
    repository_identity: repository.binding.identity,
    schema_version: SCHEMA_VERSION,
    started_at: startedAt,
  };

  const server = createCollaborationHttpServer({
    service,
    repository,
    credentials,
    daemon,
    activity,
    sessionActivity,
    staticRoot: resolve(repository.binding.rootPath, 'dist'),
  });

  /**
   * The one teardown order that preserves the singleton invariant.
   *
   * The lock is surrendered last, after this process can no longer touch SQLite. Releasing it while
   * requests are still draining would advertise ownership as free to a replacement daemon that
   * would then open the same database — and could mark an operation abandoned while this process is
   * still able to complete it.
   */
  let tearingDown = false;
  const teardown = async (): Promise<void> => {
    if (tearingDown) return;
    tearingDown = true;
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeIdleConnections();
    await activity.whenIdle();
    server.closeAllConnections();
    await closed;
    db.close();
    try {
      removeDaemonDescriptor(paths.descriptorPath);
    } catch {
      // Leftover discovery data is harmless — it names a pid that is about to be gone — and must
      // never be the reason ownership stays claimed.
    }
    lock.release();
  };

  const port = requestedPort();
  try {
    await new Promise<void>((listening, failed) => {
      server.once('error', failed);
      server.listen(port, HOST, () => {
        server.removeListener('error', failed);
        listening();
      });
    });
  } catch (error) {
    db.close();
    lock.release();
    throw new DaemonRuntimeError(
      `collabd could not bind ${HOST}:${port}: ${error instanceof Error ? error.message : String(error)}`,
      'listen_failed',
    );
  }
  server.on('error', (error) => process.stderr.write(`${JSON.stringify({ error: 'server_error', message: error.message })}\n`));

  // Anything that fails from here on leaves a listening server holding the lock and the database,
  // so it has to go through the same teardown a signal would.
  try {
    const address = server.address() as AddressInfo | null;
    if (!address) throw new DaemonRuntimeError('collabd failed to bind a loopback port', 'listen_failed');
    daemon.url = `http://${HOST}:${address.port}`;

    writeDaemonDescriptor(paths.descriptorPath, {
      url: daemon.url,
      pid: daemon.pid,
      repository_identity: daemon.repository_identity,
      schema_version: daemon.schema_version,
      agent_token: credentials.agent,
      started_at: daemon.started_at,
    });

    // The field terminal's credential is delivered only here, in the operator's own terminal. A URL
    // fragment never reaches the server, an access log, or a Referer header.
    process.stdout.write(
      [
        `SCRAPGRID collabd listening on ${daemon.url}`,
        `repository      ${repository.binding.identity}`,
        `control clients ${paths.descriptorPath}`,
        `field terminal  ${daemon.url}/#t=${credentials.browser}`,
        ...(abandoned > 0 ? [`recovered       ${abandoned} abandoned operation attempt(s)`] : []),
        '',
      ].join('\n'),
    );
  } catch (error) {
    await teardown().catch(() => undefined);
    throw error;
  }

  const shutdown = (): void => {
    if (tearingDown) {
      // A second signal abandons the drain. Exiting outright is safe in a way that releasing the
      // lock early is not: the lock outlives this process only as residue, and the next daemon
      // reclaims it precisely because this pid is gone.
      process.stderr.write('collabd shutdown interrupted; exiting with work still in flight\n');
      process.exit(1);
    }
    const draining = activity.active();
    if (draining > 0) {
      process.stdout.write(`collabd draining ${draining} in-flight operation(s) before releasing ownership\n`);
    }
    // A teardown that fails must still end the process. Its lock survives only as residue naming a
    // dead pid, which the next daemon reclaims; a live daemon without a lock is the unrecoverable one.
    void teardown().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${JSON.stringify({ error: 'shutdown_failed', message: String(error) })}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  await start();
} catch (error) {
  const code =
    error instanceof DaemonRuntimeError || error instanceof GitError || error instanceof DatabaseError
      ? error.code
      : 'daemon_start_failed';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exitCode = 1;
}
