#!/usr/bin/env node

import { connectToDaemon, invokeOperation, resolveCredential } from './client.js';
import { GitError, GitRepository } from './git.js';
import { DaemonRuntimeError } from './runtime.js';

type Options = Record<string, string | string[]>;
type Invocation = { operation: string; input: Record<string, unknown> };

function parseArguments(args: string[]): { words: string[]; options: Options; command: string[] } {
  const words: string[] = [];
  const options: Options = {};
  const commandSeparator = args.indexOf('--');
  const command = commandSeparator >= 0 ? args.slice(commandSeparator + 1) : [];
  const input = commandSeparator >= 0 ? args.slice(0, commandSeparator) : args;

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token) continue;
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = input[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    index += 1;
    const existing = options[key];
    if (existing === undefined) options[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else options[key] = [existing, value];
  }
  return { words, options, command };
}

function required(options: Options, key: string): string {
  const value = options[key];
  if (value === undefined) throw new Error(`missing required option --${key}`);
  return Array.isArray(value) ? String(value.at(-1)) : value;
}

function optional(options: Options, key: string): string | undefined {
  const value = options[key];
  return Array.isArray(value) ? value.at(-1) : value;
}

function repeated(options: Options, key: string): string[] {
  const value = options[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function integer(options: Options, key: string, fallback?: number): number {
  const raw = optional(options, key);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`--${key} must be a non-negative integer`);
  return Number(raw);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): void {
  process.stdout.write(`SCRAPGRID collaboration CLI

Every command is a request to this repository's collabd. Start the daemon first with "npm start";
the CLI never opens the collaboration database itself.

A model is authenticated by the session descriptor in its own managed worktree; the human is
authenticated by the daemon's local control credential. COLLAB_SESSION names a session descriptor
explicitly when a model is not running inside its worktree.

Global option:
  --repo PATH                            Path inside the bound repository (default current directory)

Commands:
  init
  daemon status
  status
  session open AGENT
  session replace AGENT --reason TEXT
  session close AGENT [--reason TEXT]
  session heartbeat
  sync --agent ID [--after EVENT_ID]
  agent list
  worktree bootstrap [--root PATH] [--base SHA]
  task create ID --goal TEXT [--acceptance TEXT ...] [--actor human]
  task assign-roles ID --actor human --implementer ID --reviewer ID --verifier ID
  task claim ID --agent ID --expected-version N [--ttl 900]
  task accept ID --actor human --expected-version N
  proposal submit TASK --agent ID --content TEXT
  proposal reveal TASK [--actor human]
  decision propose [--task TASK] --actor ID --statement TEXT --rationale TEXT
  decision accept DECISION --actor human
  message send --from ID --to ID [--task TASK] --body TEXT
  blocker add TASK --agent ID --description TEXT
  blocker resolve BLOCKER --agent ID
  review request TASK --agent ID --commit SHA
  review submit REVIEW --agent ID --verdict approved|needs_revision
  finding add REVIEW --agent ID --severity blocking|non_blocking --description TEXT [--location TEXT]
  finding resolve FINDING --agent ID
  policy override TASK --actor human --reason TEXT
  verify TASK --agent ID --commit SHA [--check ID | -- COMMAND [ARG ...]]
`);
}

function resolveInvocation(parsed: ReturnType<typeof parseArguments>): Invocation {
  const { words, options, command } = parsed;
  const [area, action, id] = words;

  if (area === 'init' || (area === 'daemon' && action === 'status')) return { operation: 'daemon.info', input: {} };
  if (area === 'status') return { operation: 'status', input: {} };
  if (area === 'sync') {
    return { operation: 'sync', input: { agent: required(options, 'agent'), after: integer(options, 'after', 0) } };
  }
  if (area === 'agent' && action === 'list') return { operation: 'agents.list', input: {} };
  if (area === 'session' && action === 'heartbeat') return { operation: 'session.heartbeat', input: {} };
  if (area === 'session' && action === 'open' && id) return { operation: 'session.open', input: { agent: id } };
  if (area === 'session' && action === 'replace' && id) {
    return { operation: 'session.replace', input: { agent: id, reason: required(options, 'reason') } };
  }
  if (area === 'session' && action === 'close' && id) {
    return { operation: 'session.close', input: { agent: id, reason: optional(options, 'reason') } };
  }
  if (area === 'worktree' && action === 'bootstrap') {
    return {
      operation: 'worktree.bootstrap',
      input: { rootPath: optional(options, 'root'), baseCommit: optional(options, 'base') },
    };
  }

  if (area === 'task' && action === 'create' && id) {
    return {
      operation: 'task.create',
      input: {
        id,
        goal: required(options, 'goal'),
        acceptance: repeated(options, 'acceptance'),
        actor: optional(options, 'actor') ?? 'human',
      },
    };
  }
  if (area === 'task' && action === 'assign-roles' && id) {
    return {
      operation: 'task.assign_roles',
      input: {
        taskId: id,
        actor: required(options, 'actor'),
        implementer: required(options, 'implementer'),
        reviewer: required(options, 'reviewer'),
        verifier: required(options, 'verifier'),
      },
    };
  }
  if (area === 'task' && action === 'claim' && id) {
    return {
      operation: 'task.claim',
      input: {
        taskId: id,
        agent: required(options, 'agent'),
        expectedVersion: integer(options, 'expected-version'),
        ttlSeconds: integer(options, 'ttl', 900),
      },
    };
  }
  if (area === 'task' && action === 'accept' && id) {
    return {
      operation: 'task.accept',
      input: {
        taskId: id,
        actor: required(options, 'actor'),
        expectedVersion: integer(options, 'expected-version'),
      },
    };
  }
  if (area === 'proposal' && action === 'submit' && id) {
    return {
      operation: 'proposal.submit',
      input: { taskId: id, agent: required(options, 'agent'), content: required(options, 'content') },
    };
  }
  if (area === 'proposal' && action === 'reveal' && id) {
    return { operation: 'proposal.reveal', input: { taskId: id, actor: optional(options, 'actor') ?? 'human' } };
  }
  if (area === 'decision' && action === 'propose') {
    return {
      operation: 'decision.propose',
      input: {
        taskId: optional(options, 'task'),
        actor: required(options, 'actor'),
        statement: required(options, 'statement'),
        rationale: required(options, 'rationale'),
      },
    };
  }
  if (area === 'decision' && action === 'accept' && id) {
    return { operation: 'decision.accept', input: { decisionId: id, actor: required(options, 'actor') } };
  }
  if (area === 'message' && action === 'send') {
    return {
      operation: 'message.send',
      input: {
        from: required(options, 'from'),
        to: required(options, 'to'),
        taskId: optional(options, 'task'),
        body: required(options, 'body'),
      },
    };
  }
  if (area === 'blocker' && action === 'add' && id) {
    return {
      operation: 'blocker.add',
      input: { taskId: id, agent: required(options, 'agent'), description: required(options, 'description') },
    };
  }
  if (area === 'blocker' && action === 'resolve' && id) {
    return { operation: 'blocker.resolve', input: { blockerId: id, agent: required(options, 'agent') } };
  }
  if (area === 'review' && action === 'request' && id) {
    return {
      operation: 'review.request',
      input: { taskId: id, agent: required(options, 'agent'), commit: required(options, 'commit') },
    };
  }
  if (area === 'review' && action === 'submit' && id) {
    return {
      operation: 'review.submit',
      input: { reviewId: id, agent: required(options, 'agent'), verdict: required(options, 'verdict') },
    };
  }
  if (area === 'finding' && action === 'add' && id) {
    return {
      operation: 'finding.add',
      input: {
        reviewId: id,
        agent: required(options, 'agent'),
        severity: required(options, 'severity'),
        description: required(options, 'description'),
        location: optional(options, 'location'),
      },
    };
  }
  if (area === 'finding' && action === 'resolve' && id) {
    return { operation: 'finding.resolve', input: { findingId: id, agent: required(options, 'agent') } };
  }
  if (area === 'policy' && action === 'override' && id) {
    return {
      operation: 'check_policy.override',
      input: { taskId: id, actor: required(options, 'actor'), reason: required(options, 'reason') },
    };
  }
  if (area === 'verify' && action) {
    return {
      operation: 'verification.run',
      input: {
        taskId: action,
        agent: required(options, 'agent'),
        commit: required(options, 'commit'),
        checkId: optional(options, 'check'),
        command: command.length > 0 ? command : undefined,
      },
    };
  }

  throw new Error(`unknown command: ${words.join(' ')}`);
}

async function run(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const [area] = parsed.words;
  if (!area || area === 'help') return help();
  if (optional(parsed.options, 'db') !== undefined) {
    throw new Error('--db is no longer accepted: collabd owns the collaboration database. Set COLLAB_DB before starting the daemon.');
  }

  const startPath = optional(parsed.options, 'repo') ?? process.cwd();
  const repository = GitRepository.discover(startPath);
  const invocation = resolveInvocation(parsed);
  const descriptor = connectToDaemon(repository);
  const credential = resolveCredential(descriptor, startPath);
  const result = await invokeOperation(descriptor, credential.token, invocation.operation, invocation.input);
  print(result);

  if (invocation.operation === 'verification.run') {
    const exitCode = Number((result as Record<string, unknown>)['exit_code']);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

try {
  await run();
} catch (error) {
  // Domain rejections arrive as daemon frames; only discovery and local Git failures originate here.
  const code =
    error instanceof DaemonRuntimeError || error instanceof GitError ? error.code : 'usage_error';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exitCode = 1;
}
