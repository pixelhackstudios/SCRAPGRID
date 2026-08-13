import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../collab/database.js';
import { createCollaborationHttpServer } from '../collab/http.js';
import {
  classifyNativeProcess,
  claudeProjectDir,
  createFsObserveHost,
  grokSessionRoot,
  parseClaudeRecord,
  parseCodexRecord,
  parseGrokChatRecord,
  parseGrokEventRecord,
  RuntimeObserver,
  takeCompleteLines,
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
      const buffer = Buffer.from(text, 'utf8');
      const size = buffer.length;
      if (size <= offset) return { data: Buffer.alloc(0), size };
      return { data: buffer.subarray(offset), size };
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
  assert.doesNotMatch(claude?.body ?? '', /Need to read App\.tsx/);

  const thinkingOnly = parseClaudeRecord({
    type: 'assistant',
    timestamp: '2026-08-13T03:00:01.500Z',
    sessionId: 'sess-1',
    message: { content: [{ type: 'thinking', thinking: 'SECRET PRIVATE CHAIN OF THOUGHT' }] },
  });
  assert.equal(thinkingOnly?.stream, false);
  assert.equal(thinkingOnly?.activity, 'thinking');
  assert.equal(thinkingOnly?.body, '');

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

test('JSONL consumption uses byte offsets so emoji does not skip or duplicate lines', () => {
  const first = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello 🔥' }] } })}\n`, 'utf8');
  const second = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'next' }] } })}\n`, 'utf8');
  assert.ok(first.length > first.toString('utf8').length, 'emoji must make UTF-8 bytes exceed JS string length');
  const torn = takeCompleteLines(Buffer.concat([first, second.subarray(0, 8)]));
  assert.equal(torn.consumed, first.length);
  assert.equal(torn.lines.length, 1);
  const whole = takeCompleteLines(Buffer.concat([first, second]));
  assert.equal(whole.consumed, first.length + second.length);
  assert.equal(whole.lines.length, 2);
});

test('real filesystem tail resumes after a multibyte line without duplicating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'scrapgrid-observe-bytes-'));
  try {
    const path = join(root, 'session.jsonl');
    const first = `${JSON.stringify({ ok: '🔥' })}\n`;
    writeFileSync(path, first);
    const host = createFsObserveHost({ repoRoot: root, worktrees: () => [], home: root });
    const start = host.readPartial(path, 0);
    assert.ok(start);
    const parsed = takeCompleteLines(start.data);
    assert.equal(parsed.consumed, Buffer.byteLength(first));
    appendFileSync(path, `${JSON.stringify({ ok: 'next' })}\n`);
    const more = host.readPartial(path, parsed.consumed);
    assert.ok(more);
    const next = takeCompleteLines(more.data);
    assert.equal(next.lines.length, 1);
    assert.match(next.lines[0] ?? '', /next/);
    assert.doesNotMatch(next.lines.join('\n'), /🔥/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('observer does not replay historical Claude transcripts from other sessions or worktrees', () => {
  const repo = '/repo';
  const worktree = '/repo/worktrees/claude';
  const home = '/home/me';
  const liveDir = claudeProjectDir(home, repo);
  const staleDir = claudeProjectDir(home, worktree);
  const host = memoryHost({
    home,
    repoRoot: repo,
    worktrees: [{ agent_id: 'claude', path: worktree }],
    processes: [{ pid: 42, cwd: repo, comm: 'claude', cmdline: 'claude' }],
    files: {
      [join(home, '.claude', 'sessions', '99.json')]: JSON.stringify({
        pid: 99,
        sessionId: 'sess-old',
        cwd: worktree,
        status: 'idle',
        updatedAt: 9,
      }),
      [join(home, '.claude', 'sessions', '42.json')]: JSON.stringify({
        pid: 42,
        sessionId: 'sess-live',
        cwd: repo,
        status: 'idle',
        updatedAt: 1,
      }),
      [join(staleDir, 'sess-old.jsonl')]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-12T03:00:00.000Z',
        sessionId: 'sess-old',
        message: { content: [{ type: 'text', text: 'yesterday leftover from another session' }] },
      })}\n`,
      [join(liveDir, 'unrelated.jsonl')]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T03:00:00.000Z',
        sessionId: 'sess-other',
        message: { content: [{ type: 'text', text: 'orphaned historical transcript' }] },
      })}\n`,
      [join(liveDir, 'sess-live.jsonl')]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-13T03:00:04.000Z',
        sessionId: 'sess-live',
        message: { content: [{ type: 'text', text: 'current live output' }] },
      })}\n`,
    },
  });
  const view = new RuntimeObserver(host).tick();
  assert.equal(view.runtimes.find((row) => row.agent_id === 'claude')?.native_session_id, 'sess-live');
  assert.ok(view.events.some((event) => event.body.includes('current live output')));
  assert.equal(view.events.some((event) => event.body.includes('yesterday leftover')), false);
  assert.equal(view.events.some((event) => event.body.includes('orphaned historical')), false);
});

test('observer reports Claude presence without replaying history when no current transcript is known', () => {
  const repo = '/repo';
  const home = '/home/me';
  const project = claudeProjectDir(home, repo);
  const host = memoryHost({
    home,
    repoRoot: repo,
    processes: [{ pid: 42, cwd: repo, comm: 'claude', cmdline: 'claude' }],
    files: {
      [join(project, 'sess-old.jsonl')]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T03:00:00.000Z',
        sessionId: 'sess-old',
        message: { content: [{ type: 'text', text: 'stale session should stay buried' }] },
      })}\n`,
    },
  });
  const view = new RuntimeObserver(host).tick();
  assert.equal(view.runtimes.find((row) => row.agent_id === 'claude')?.presence, 'connected');
  assert.equal(view.runtimes.find((row) => row.agent_id === 'claude')?.native_session_id, null);
  assert.equal(view.events.some((event) => event.body.includes('stale session should stay buried')), false);
});

test('observer tails the newest Codex rollout for the live process cwd, not readdir order', () => {
  const repo = '/repo';
  const home = '/home/me';
  const day = join(home, '.codex', 'sessions', '2026', '08', '13');
  const older = join(day, 'rollout-2026-08-13T01-00-00-aaaa.jsonl');
  const newer = join(day, 'rollout-2026-08-13T02-00-00-bbbb.jsonl');
  const otherCwd = join(day, 'rollout-2026-08-13T03-00-00-cccc.jsonl');
  const host = memoryHost({
    now: Date.parse('2026-08-13T03:00:00.000Z'),
    home,
    repoRoot: repo,
    processes: [{ pid: 9, cwd: repo, comm: 'codex', cmdline: 'codex' }],
    files: {
      [newer]: `${JSON.stringify({
        timestamp: '2026-08-13T02:00:00.000Z',
        type: 'session_meta',
        payload: { cwd: repo, session_id: 'new', timestamp: '2026-08-13T02:00:00.000Z' },
      })}\n${JSON.stringify({
        timestamp: '2026-08-13T02:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from newest rollout' }] },
      })}\n`,
      [older]: `${JSON.stringify({
        timestamp: '2026-08-13T01:00:00.000Z',
        type: 'session_meta',
        payload: { cwd: repo, session_id: 'old', timestamp: '2026-08-13T01:00:00.000Z' },
      })}\n${JSON.stringify({
        timestamp: '2026-08-13T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from older rollout' }] },
      })}\n`,
      [otherCwd]: `${JSON.stringify({
        timestamp: '2026-08-13T03:00:00.000Z',
        type: 'session_meta',
        payload: { cwd: '/elsewhere', session_id: 'other', timestamp: '2026-08-13T03:00:00.000Z' },
      })}\n${JSON.stringify({
        timestamp: '2026-08-13T03:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from other cwd' }] },
      })}\n`,
    },
  });
  const view = new RuntimeObserver(host).tick();
  assert.equal(view.runtimes.find((row) => row.agent_id === 'codex')?.native_session_id, 'new');
  assert.ok(view.events.some((event) => event.body.includes('from newest rollout')));
  assert.equal(view.events.some((event) => event.body.includes('from older rollout')), false);
  assert.equal(view.events.some((event) => event.body.includes('from other cwd')), false);
});

test('observer streams assistant output and tools but not raw Claude thinking bodies', () => {
  const repo = '/repo';
  const home = '/home/me';
  const transcript = join(claudeProjectDir(home, repo), 'sess-live.jsonl');
  const host = memoryHost({
    home,
    repoRoot: repo,
    processes: [{ pid: 42, cwd: repo, comm: 'claude', cmdline: 'claude' }],
    files: {
      [join(home, '.claude', 'sessions', '42.json')]: JSON.stringify({
        pid: 42,
        sessionId: 'sess-live',
        cwd: repo,
        status: 'busy',
      }),
      [transcript]: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-13T03:00:04.000Z',
        sessionId: 'sess-live',
        message: { content: [{ type: 'thinking', thinking: 'do not leak this private reasoning' }] },
      })}\n${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-13T03:00:05.000Z',
        sessionId: 'sess-live',
        message: { content: [{ type: 'text', text: 'Visible answer only.' }] },
      })}\n`,
    },
  });
  const view = new RuntimeObserver(host).tick();
  assert.ok(view.events.some((event) => event.kind === 'output' && event.body.includes('Visible answer only.')));
  assert.equal(view.events.some((event) => event.body.includes('do not leak this private reasoning')), false);
});
