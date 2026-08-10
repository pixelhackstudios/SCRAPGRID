#!/usr/bin/env node

import { resolve } from 'node:path';
import { DatabaseError, defaultDatabasePath, initializeDatabase, openDatabase } from './database.js';
import { GitError, GitRepository } from './git.js';
import { CollaborationError, CollaborationService } from './service.js';

type Options = Record<string, string | string[]>;

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

Global option:
  --db PATH                              SQLite path (default .collab/collab.db)
  --repo PATH                            Path inside the bound repository (default current directory)

Commands:
  init
  status
  sync --agent ID [--after EVENT_ID]
  agent list
  worktree bootstrap [--root PATH] [--base SHA]
  task create ID --goal TEXT [--acceptance TEXT ...] [--actor human]
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

async function run(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const repository = GitRepository.discover(optional(parsed.options, 'repo'));
  const dbPath = optional(parsed.options, 'db');
  const db = openDatabase(dbPath ?? defaultDatabasePath(repository.binding.rootPath));
  try {
    initializeDatabase(db, repository.binding, repository.headCommit());
    const service = new CollaborationService(db, repository);
    const [area, action, id] = parsed.words;

    if (!area || area === 'help') return help();
    if (area === 'init') {
      return print({
        database: dbPath ?? defaultDatabasePath(repository.binding.rootPath),
        repository: repository.binding,
        agents: service.listAgents(),
      });
    }
    if (area === 'status') return print(service.status());
    if (area === 'sync') {
      return print(service.sync(required(parsed.options, 'agent'), integer(parsed.options, 'after', 0)));
    }
    if (area === 'agent' && action === 'list') return print(service.listAgents());
    if (area === 'worktree' && action === 'bootstrap') {
      return print(
        service.bootstrapWorktrees({
          rootPath: optional(parsed.options, 'root') ?? resolve(repository.binding.rootPath, 'worktrees'),
          baseCommit: optional(parsed.options, 'base') ?? repository.headCommit(),
        }),
      );
    }

    if (area === 'task' && action === 'create' && id) {
      return print(
        service.createTask({
          id,
          goal: required(parsed.options, 'goal'),
          acceptance: repeated(parsed.options, 'acceptance'),
          actor: optional(parsed.options, 'actor') ?? 'human',
        }),
      );
    }
    if (area === 'task' && action === 'claim' && id) {
      return print(
        service.claimTask({
          taskId: id,
          agent: required(parsed.options, 'agent'),
          expectedVersion: integer(parsed.options, 'expected-version'),
          ttlSeconds: integer(parsed.options, 'ttl', 900),
        }),
      );
    }
    if (area === 'task' && action === 'accept' && id) {
      return print(
        service.acceptTask({
          taskId: id,
          actor: required(parsed.options, 'actor'),
          expectedVersion: integer(parsed.options, 'expected-version'),
        }),
      );
    }
    if (area === 'proposal' && action === 'submit' && id) {
      return print(
        service.submitProposal({
          taskId: id,
          agent: required(parsed.options, 'agent'),
          content: required(parsed.options, 'content'),
        }),
      );
    }
    if (area === 'proposal' && action === 'reveal' && id) {
      return print(service.revealProposals(id, optional(parsed.options, 'actor') ?? 'human'));
    }
    if (area === 'decision' && action === 'propose') {
      return print(
        service.proposeDecision({
          taskId: optional(parsed.options, 'task'),
          actor: required(parsed.options, 'actor'),
          statement: required(parsed.options, 'statement'),
          rationale: required(parsed.options, 'rationale'),
        }),
      );
    }
    if (area === 'decision' && action === 'accept' && id) {
      return print(service.acceptDecision(id, required(parsed.options, 'actor')));
    }
    if (area === 'message' && action === 'send') {
      return print(
        service.sendMessage({
          from: required(parsed.options, 'from'),
          to: required(parsed.options, 'to'),
          taskId: optional(parsed.options, 'task'),
          body: required(parsed.options, 'body'),
        }),
      );
    }
    if (area === 'blocker' && action === 'add' && id) {
      return print(
        service.addBlocker({
          taskId: id,
          agent: required(parsed.options, 'agent'),
          description: required(parsed.options, 'description'),
        }),
      );
    }
    if (area === 'blocker' && action === 'resolve' && id) {
      return print(service.resolveBlocker(id, required(parsed.options, 'agent')));
    }
    if (area === 'review' && action === 'request' && id) {
      return print(
        service.requestReview({
          taskId: id,
          agent: required(parsed.options, 'agent'),
          commit: required(parsed.options, 'commit'),
        }),
      );
    }
    if (area === 'review' && action === 'submit' && id) {
      const verdict = required(parsed.options, 'verdict');
      if (verdict !== 'approved' && verdict !== 'needs_revision') {
        throw new Error('--verdict must be approved or needs_revision');
      }
      return print(service.submitReview({ reviewId: id, agent: required(parsed.options, 'agent'), verdict }));
    }
    if (area === 'finding' && action === 'add' && id) {
      const severity = required(parsed.options, 'severity');
      if (severity !== 'blocking' && severity !== 'non_blocking') {
        throw new Error('--severity must be blocking or non_blocking');
      }
      return print(
        service.addReviewFinding({
          reviewId: id,
          agent: required(parsed.options, 'agent'),
          severity,
          description: required(parsed.options, 'description'),
          location: optional(parsed.options, 'location'),
        }),
      );
    }
    if (area === 'finding' && action === 'resolve' && id) {
      return print(service.resolveReviewFinding(id, required(parsed.options, 'agent')));
    }
    if (area === 'policy' && action === 'override' && id) {
      return print(
        service.overrideCheckPolicy({
          taskId: id,
          actor: required(parsed.options, 'actor'),
          reason: required(parsed.options, 'reason'),
        }),
      );
    }
    if (area === 'verify' && action) {
      const checkId = optional(parsed.options, 'check');
      if (Boolean(checkId) === (parsed.command.length > 0)) {
        throw new Error('verify requires exactly one of --check ID or an explicit command after --');
      }
      const record = await service.runVerification({
        taskId: action,
        agent: required(parsed.options, 'agent'),
        commit: required(parsed.options, 'commit'),
        checkId,
        command: parsed.command.length > 0 ? parsed.command : undefined,
      });
      print(record);
      const exitCode = Number(record['exit_code']);
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    throw new Error(`unknown command: ${parsed.words.join(' ')}`);
  } finally {
    db.close();
  }
}

try {
  await run();
} catch (error) {
  const code =
    error instanceof CollaborationError || error instanceof GitError || error instanceof DatabaseError
      ? error.code
      : 'usage_error';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exitCode = 1;
}
