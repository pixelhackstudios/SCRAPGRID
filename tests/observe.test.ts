import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { createCollaborationHttpServer } from '../collab/http.js';
import {
  classifyNativeProcess,
  claudeProjectDir,
  grokSessionRoot,
  parseClaudeRecord,
  parseCodexRecord,
  parseGrokChatRecord,
  parseGrokEventRecord,
  RuntimeObserver,
  type ObserveHost,
  type ObservedProcess,
  type ObservedWorktree,
} from '../collab/observe.js';
import { CollaborationService } from '../collab/service.js';
import { GitRepository } from '../collab/git.js';
import { SCHEMA_VERSION } from '../collab/schema.js';
import { execFileSync } from 'node:child_process';

function memoryHost(options: {
  now?: number;
  home: string;
  repoRoot: string;
  worktrees?: ObservedWorktree[];
  files?: Record<string, string>;
  processes?: ObservedProcess[];
}): ObserveHost & { files: Map<string, string>; processes: ObservedProcess[]; nowMs: number } {
  const files = new Map(Object.entries(options.files ?? {}));
  const host = {
    nowMs: options.now ?? Date.parse('2026-08-13T03:00:00.000Z'),
    files,
    processes: options.processes ?? [],
    now: () => host.nowMs,
    home: () => options.home,
    repoRoot: () => options.repoRoot,
    worktrees: () => options.worktrees ?? [],
    readFile: (path: string) => host.files.get(path) ?? null,
    readDir: (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of host.files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name) names.add(name);
      }
      return names.size > 0 ? [...names] : null;
    },
    readPartial: (path: string, offset: number) => {
      const text = host.files.get(path);
      if (text === undefined) return null;
      const size = text.length;
      if (size <= offset) return { data: '', size };
      return { data: text.slice(offset), size };
    },
    listProcPids: () => host.processes.map((process) => String(process.pid)),
    processOf: (pid: string) => host.processes.find((process) => String(process.pid) === pid) ?? null,
  };
  return host;
}

test('native process classification ignores desktop ChatGPT helpers', () => {
  assert.equal(classifyNativeProcess({ pid: 1, cwd: '/repo', comm: 'claude', cmdline: 'claude' }), 'claude');
  assert.equal(classifyNativeProcess({ pid: 2, cwd: '/repo', comm: 'grok', cmdline: 'grok' }), 'grok');
  assert.equal(
    classifyNativeProcess({
      pid: 3,
      cwd: '/repo',
      comm: 'codex',
      cmdline: 'node /home/x/.nvm/versions/node/bin/codex',
    }),
    'codex',
  );
  assert.equal(
    classifyNativeProcess({
      pid: 4,
      cwd: '/repo',
      comm: 'ChatGPT',
      cmdline: '/usr/lib/chatgpt/ChatGPT --user-data-dir=/home/x/.config/Codex',
    }),
    null,
  );
});

test('transcript parsers extract thinking, tools, and assistant output', () => {
  const claude = parseClaudeRecord({
    type: 'assistant',
    timestamp: '2026-08-13T03:00:01.000Z',
    sessionId: 'sess-1',
    message: {
      content: [
        { type: 'thinking', thinking: 'Need to read App.tsx' },
        { type: 'tool_use', name: 'read_file' },
      ],
    },
  });
  assert.equal(claude?.kind, 'tool');
  assert.equal(claude?.activity, 'reading');
  assert.match(claude?.title ?? '', /read_file/);

  const grokPhase = parseGrokEventRecord({ type: 'phase_changed', phase: 'thinking', ts: '2026-08-13T03:00:02.000Z' });
  assert.equal(grokPhase?.stream, false);
  assert.equal(grokPhase?.activity, 'thinking');

  const grokTool = parseGrokEventRecord({ type: 'tool_started', tool_name: 'run_terminal_command' });
  assert.equal(grokTool?.activity, 'running_command');

  const grokChat = parseGrokChatRecord({
    type: 'assistant',
    content: 'Claude is idle, not missing.',
    tool_calls: [{ name: 'read_file' }],
  });
  assert.equal(grokChat?.kind, 'output');
  assert.match(grokChat?.body ?? '', /Claude is idle/);

  const codex = parseCodexRecord({
    timestamp: '2026-08-13T03:00:03.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'rg', role: 'assistant' },
  });
  assert.equal(codex?.kind, 'tool');
  assert.equal(codex?.activity, 'reading');
});

test('observer reports not_connected until a native process appears', () => {
  const host = memoryHost({
    home: '/home/me',
    repoRoot: '/repo',
  });
  const observer = new RuntimeObserver(host);
  const view = observer.tick();
  assert.equal(view.runtimes.find((row) => row.agent_id === 'claude')?.presence, 'not_connected');
  assert.equal(view.runtimes.find((row) => row.agent_id === 'claude')?.summary, 'Not connected.');
});

test('observer sees a live Claude process and tails its project transcript', () => {
  const repo = '/repo';
  const home = '/home/me';
  const project = claudeProjectDir(home, repo);
  const transcript = join(project, 'sess-live.jsonl');
  const host = memoryHost({
    home,
    repoRoot: repo,
    processes: [{ pid: 42, cwd: repo, comm: 'claude', cmdline: 'claude' }],
    files: {
      [join(home, '.claude', 'sessions', '42.json')]: JSON.stringify({
        pid: 42,
        sessionId: 'sess-live',
        cwd: repo,
        status: 'idle',
      }),
      [transcript]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-13T03:00:04.000Z',
        sessionId: 'sess-live',
        message: { content: [{ type: 'text', text: 'I will review the candidate commit.' }] },
      })}\n`,
    },
  });
  const observer = new RuntimeObserver(host);
  const first = observer.tick();
  const claude = first.runtimes.find((row) => row.agent_id === 'claude');
  assert.equal(claude?.presence, 'working');
  assert.equal(claude?.pid, 42);
  assert.equal(claude?.native_session_id, 'sess-live');
  assert.ok(first.events.some((event) => event.kind === 'output' && event.body.includes('review the candidate')));

  host.nowMs += 30_000;
  const later = observer.tick();
  assert.equal(later.runtimes.find((row) => row.agent_id === 'claude')?.presence, 'connected');
  assert.equal(later.runtimes.find((row) => row.agent_id === 'claude')?.summary, 'Connected. Idle.');
});

test('observer follows Grok events.jsonl tools without treating them as coordination events', () => {
  const repo = '/repo';
  const home = '/home/me';
  const session = 'sid-grok';
  const eventsPath = join(grokSessionRoot(home, repo), session, 'events.jsonl');
  const chatPath = join(grokSessionRoot(home, repo), session, 'chat_history.jsonl');
  const host = memoryHost({
    home,
    repoRoot: repo,
    processes: [{ pid: 7, cwd: repo, comm: 'grok', cmdline: 'grok' }],
    files: {
      [join(home, '.grok', 'active_sessions.json')]: JSON.stringify([{ session_id: session, pid: 7, cwd: repo }]),
      [eventsPath]: `${JSON.stringify({ type: 'tool_started', tool_name: 'read_file', ts: '2026-08-13T03:00:05.000Z' })}\n`,
      [chatPath]: `${JSON.stringify({ type: 'assistant', content: 'The cards only show dispatch state.' })}\n`,
    },
  });
  const observer = new RuntimeObserver(host);
  const view = observer.tick();
  const grok = view.runtimes.find((row) => row.agent_id === 'grok');
  assert.equal(grok?.presence, 'working');
  assert.equal(grok?.activity, 'writing');
  assert.ok(view.events.some((event) => event.kind === 'tool' && event.title.includes('read_file')));
  assert.ok(view.events.some((event) => event.kind === 'output' && event.body.includes('dispatch state')));
});

test('observer marks a vanished process disconnected instead of waiting their turn', () => {
  const host = memoryHost({
    home: '/home/me',
    repoRoot: '/repo',
    processes: [{ pid: 9, cwd: '/repo', comm: 'codex', cmdline: 'codex' }],
  });
  const observer = new RuntimeObserver(host);
  assert.equal(observer.tick().runtimes.find((row) => row.agent_id === 'codex')?.presence, 'connected');
  host.processes = [];
  const gone = observer.tick();
  assert.equal(gone.runtimes.find((row) => row.agent_id === 'codex')?.presence, 'disconnected');
  assert.equal(gone.runtimes.find((row) => row.agent_id === 'codex')?.summary, 'Disconnected.');
});

test('field terminal snapshot and /api/runtime expose the observation plane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrapgrid-observe-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'SCRAPGRID Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@scrapgrid.invalid']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'init']);
  const db = openDatabase(':memory:');
  const repository = GitRepository.discover(root);
  initializeDatabase(db, repository.binding, repository.headCommit());
  const service = new CollaborationService(db, repository);
  const host = memoryHost({
    home: '/home/me',
    repoRoot: root,
    processes: [{ pid: 11, cwd: root, comm: 'claude', cmdline: 'claude' }],
  });
  const observer = new RuntimeObserver(host);
  const server = createCollaborationHttpServer({
    service,
    repository,
    observer,
    credentials: { agent: 'agent', browser: 'browser' },
    daemon: {
      url: 'http://127.0.0.1:0',
      pid: process.pid,
      repository_identity: repository.binding.identity,
      schema_version: SCHEMA_VERSION,
      started_at: new Date().toISOString(),
    },
  });
  try {
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const snapshot = (await (await fetch(`${origin}/api/snapshot`, { headers: { authorization: 'Bearer browser' } })).json()) as {
      runtimes: Array<{ agent_id: string; presence: string }>;
    };
    assert.equal(snapshot.runtimes.find((row) => row.agent_id === 'claude')?.presence, 'connected');
    const runtime = (await (await fetch(`${origin}/api/runtime`, { headers: { authorization: 'Bearer browser' } })).json()) as {
      runtimes: unknown;
      events: unknown;
    };
    assert.ok(Array.isArray(runtime.runtimes));
    assert.ok(Array.isArray(runtime.events));
    const denied = await fetch(`${origin}/api/runtime`);
    assert.equal(denied.status, 401);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
