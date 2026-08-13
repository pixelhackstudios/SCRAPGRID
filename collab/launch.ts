#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectToDaemon, invokeOperation } from './client.js';
import { GitRepository } from './git.js';
import {
  daemonRuntimePaths,
  isProcessAlive,
  readDaemonDescriptor,
  readFieldTerminalSidecar,
  type DaemonDescriptor,
  type FieldTerminalSidecar,
} from './runtime.js';

const DIST_COLLAB = dirname(fileURLToPath(import.meta.url));
const COLLABD_ENTRY = resolve(DIST_COLLAB, 'collabd.js');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function liveDescriptor(paths: ReturnType<typeof daemonRuntimePaths>, repositoryIdentity: string): DaemonDescriptor | null {
  if (!existsSync(paths.descriptorPath)) return null;
  try {
    const descriptor = readDaemonDescriptor(paths.descriptorPath);
    if (descriptor.repository_identity !== repositoryIdentity) return null;
    if (!isProcessAlive(descriptor.pid)) return null;
    return descriptor;
  } catch {
    return null;
  }
}

function matchingSidecar(
  paths: ReturnType<typeof daemonRuntimePaths>,
  descriptor: DaemonDescriptor,
): FieldTerminalSidecar | null {
  if (!existsSync(paths.fieldTerminalPath)) return null;
  try {
    const sidecar = readFieldTerminalSidecar(paths.fieldTerminalPath);
    if (sidecar.pid !== descriptor.pid) return null;
    if (sidecar.repository_identity !== descriptor.repository_identity) return null;
    if (!sidecar.url.includes('#t=')) return null;
    return sidecar;
  } catch {
    return null;
  }
}

function openUrl(url: string): void {
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Opening a browser is best-effort.
  }
}

function printBanner(descriptor: DaemonDescriptor, sidecar: FieldTerminalSidecar | null, worktrees: Array<Record<string, unknown>>): void {
  const lines = [
    `SCRAPGRID harness`,
    `daemon          ${descriptor.url}`,
    `repository      ${descriptor.repository_identity}`,
    `worktrees`,
  ];
  if (worktrees.length === 0) {
    lines.push('  (none registered — bootstrap after the daemon is up)');
  }
  for (const worktree of worktrees) {
    const agent = String(worktree['agent_id'] ?? 'unknown');
    const path = String(worktree['worktree_path'] ?? '');
    const head = String(worktree['head_commit'] ?? '').slice(0, 9);
    lines.push(`  ${agent.padEnd(8)} ${path}  ${head}`);
  }
  lines.push(sidecar ? `field terminal  ${sidecar.url}` : 'field terminal  unavailable (sidecar missing or mismatched)');
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function worktreesFromDaemon(repository: GitRepository): Promise<Array<Record<string, unknown>>> {
  const descriptor = connectToDaemon(repository);
  const status = (await invokeOperation(descriptor, descriptor.agent_token, 'status', {})) as Record<string, unknown>;
  const worktrees = status['worktrees'];
  return Array.isArray(worktrees) ? (worktrees as Array<Record<string, unknown>>) : [];
}

async function bootstrapIfMissing(repository: GitRepository): Promise<void> {
  const existing = await worktreesFromDaemon(repository);
  if (existing.length >= 3) return;
  const descriptor = connectToDaemon(repository);
  await invokeOperation(descriptor, descriptor.agent_token, 'worktree.bootstrap', {
    rootPath: `${repository.binding.rootPath}/worktrees`,
    baseCommit: repository.headCommit(),
  });
}

async function waitForDaemon(
  child: ReturnType<typeof spawn>,
  paths: ReturnType<typeof daemonRuntimePaths>,
  repositoryIdentity: string,
): Promise<DaemonDescriptor> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('collabd exited before publishing its descriptor');
    }
    const descriptor = liveDescriptor(paths, repositoryIdentity);
    if (descriptor && matchingSidecar(paths, descriptor)) return descriptor;
    await delay(50);
  }
  throw new Error('collabd did not publish a matching field-terminal sidecar');
}

async function start(): Promise<void> {
  const repoPath = resolve(option('repo') ?? process.cwd());
  const repository = GitRepository.discover(repoPath);
  const paths = daemonRuntimePaths(repository.binding.rootPath);
  const existing = liveDescriptor(paths, repository.binding.identity);

  if (existing) {
    const sidecar = matchingSidecar(paths, existing);
    let trees: Array<Record<string, unknown>> = [];
    try {
      trees = await worktreesFromDaemon(repository);
    } catch {
      trees = [];
    }
    printBanner(existing, sidecar, trees);
    if (sidecar) openUrl(sidecar.url);
    return;
  }

  const child = spawn(process.execPath, [COLLABD_ENTRY], {
    cwd: repository.binding.rootPath,
    env: { ...process.env, COLLAB_REPO: repository.binding.rootPath },
    stdio: 'inherit',
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const descriptor = await waitForDaemon(child, paths, repository.binding.identity);
  await bootstrapIfMissing(repository);
  const sidecar = matchingSidecar(paths, descriptor);
  const trees = await worktreesFromDaemon(repository);
  printBanner(descriptor, sidecar, trees);
  if (sidecar) openUrl(sidecar.url);

  await new Promise<void>((done, fail) => {
    child.once('exit', (code) => {
      if (code === 0 || code === null) done();
      else fail(new Error(`collabd exited with status ${code}`));
    });
    child.once('error', fail);
  });
}

try {
  await start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: 'launch_failed', message })}\n`);
  process.exitCode = 1;
}
