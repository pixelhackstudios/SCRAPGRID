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
import { createCollaborationHttpServer } from './http.js';
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
import { CollaborationService } from './service.js';

const HOST = '127.0.0.1';

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
  let releasing = false;
  const releaseRuntime = (): void => {
    if (releasing) return;
    releasing = true;
    removeDaemonDescriptor(paths.descriptorPath);
    lock.release();
  };

  let db;
  try {
    db = openDatabase(defaultDatabasePath(repository.binding.rootPath));
    initializeDatabase(db, repository.binding, repository.headCommit());
  } catch (error) {
    releaseRuntime();
    throw error;
  }

  const abandoned = recoverAbandonedOperations(db);
  const service = new CollaborationService(db, repository);
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
    staticRoot: resolve(repository.binding.rootPath, 'dist'),
  });

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
    releaseRuntime();
    db.close();
    throw new DaemonRuntimeError(
      `collabd could not bind ${HOST}:${port}: ${error instanceof Error ? error.message : String(error)}`,
      'listen_failed',
    );
  }
  server.on('error', (error) => process.stderr.write(`${JSON.stringify({ error: 'server_error', message: error.message })}\n`));

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
      `agent clients   ${paths.descriptorPath}`,
      `field terminal  ${daemon.url}/#t=${credentials.browser}`,
      ...(abandoned > 0 ? [`recovered       ${abandoned} abandoned operation attempt(s)`] : []),
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    releaseRuntime();
    server.close(() => {
      db.close();
      process.exit(0);
    });
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
