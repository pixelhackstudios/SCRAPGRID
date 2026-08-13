/**
 * Runtime observation plane.
 *
 * Coordination truth stays in SQLite. This module never writes to the operation ledger or the
 * domain event stream. It watches the native Claude Code, Codex, and Grok processes the human
 * already runs, tails the transcripts those CLIs already write, and projects a Field Terminal
 * view: presence, current activity, and recent output.
 *
 * A live observation means a native runtime is observable from this machine. It is not a
 * collaboration session, a dispatch, or proof of a model's internal state beyond what the
 * runtime itself recorded.
 */

import { closeSync, openSync, readFileSync, readdirSync, readSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

export const MODEL_AGENTS = ['claude', 'codex', 'grok'] as const;
export type ModelAgentId = (typeof MODEL_AGENTS)[number];
export type RuntimePresence = 'not_connected' | 'connected' | 'working' | 'disconnected';
export type RuntimeActivity =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'running_command'
  | 'using_tool'
  | 'writing'
  | 'reviewing'
  | 'verifying'
  | 'waiting';
export type RuntimeEventKind = 'presence' | 'thought' | 'tool' | 'output';

export interface RuntimeAgentState {
  agent_id: ModelAgentId;
  presence: RuntimePresence;
  activity: RuntimeActivity | null;
  summary: string;
  pid: number | null;
  cwd: string | null;
  native_session_id: string | null;
  last_observed_at: string | null;
}

export interface RuntimeEvent {
  id: number;
  agent_id: ModelAgentId;
  kind: RuntimeEventKind;
  title: string;
  body: string;
  timestamp: string;
}

export interface RuntimeView {
  runtimes: RuntimeAgentState[];
  events: RuntimeEvent[];
  cursor: number;
}

export interface ObservedProcess {
  pid: number;
  cwd: string;
  cmdline: string;
  comm: string;
}

export interface ObservedWorktree {
  agent_id: string;
  path: string;
}

export interface ObserveHost {
  now(): number;
  home(): string;
  repoRoot(): string;
  worktrees(): ObservedWorktree[];
  readFile(path: string): string | null;
  readDir(path: string): string[] | null;
  readPartial(path: string, offset: number): { data: Buffer; size: number } | null;
  listProcPids(): string[];
  processOf(pid: string): ObservedProcess | null;
}

interface ParsedRecord {
  stream: boolean;
  kind: RuntimeEventKind;
  title: string;
  body: string;
  activity?: RuntimeActivity;
  timestamp?: string;
  sessionId?: string;
}

const WORKING_MS = 12_000;
const DISCONNECTED_HOLD_MS = 60_000;
const MAX_EVENTS = 180;
const MAX_BODY = 900;
const FIRST_LOOKBACK_BYTES = 262_144;
const FIRST_EMIT_PER_FILE = 16;

const TOOL_ACTIVITY: Array<[RegExp, RuntimeActivity]> = [
  [/(review)/i, 'reviewing'],
  [/(verif)/i, 'verifying'],
  [/(read|search|grep|\brg\b|glob|list_dir|list-dir)/i, 'reading'],
  [/(bash|shell|terminal|command|exec|run_terminal)/i, 'running_command'],
];

export function emptyRuntimeView(): RuntimeView {
  return {
    runtimes: MODEL_AGENTS.map((agent_id) => idleState(agent_id, 'not_connected')),
    events: [],
    cursor: 0,
  };
}

export function createFsObserveHost(options: {
  repoRoot: string;
  worktrees: () => ObservedWorktree[];
  home?: string;
}): ObserveHost {
  const home = options.home ?? homedir();
  return {
    now: () => Date.now(),
    home: () => home,
    repoRoot: () => options.repoRoot,
    worktrees: options.worktrees,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    readDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    readPartial: (path, offset) => {
      try {
        const size = statSync(path).size;
        if (size <= offset) return { data: Buffer.alloc(0), size };
        const fd = openSync(path, 'r');
        try {
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          const bytes = readSync(fd, buffer, 0, length, offset);
          return { data: buffer.subarray(0, bytes), size };
        } finally {
          closeSync(fd);
        }
      } catch {
        return null;
      }
    },
    listProcPids: () => {
      try {
        return readdirSync('/proc').filter((name) => /^\d+$/.test(name));
      } catch {
        return [];
      }
    },
    processOf: (pid) => {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        return { pid: Number(pid), cwd, cmdline, comm };
      } catch {
        return null;
      }
    },
  };
}

export function classifyNativeProcess(process: ObservedProcess): ModelAgentId | null {
  const haystack = `${process.comm} ${process.cmdline}`;
  if (/(?:^|\/|\s)claude(?:\s|$)/.test(haystack)) return 'claude';
  if (/(?:^|\/|\s)grok(?:\s|$)/.test(haystack)) return 'grok';
  if (haystack.includes('ChatGPT') && !haystack.includes('@openai/codex')) return null;
  if (haystack.includes('@openai/codex') || /(?:^|\/|\s)codex(?:\s|$)/.test(haystack)) return 'codex';
  return null;
}

export function claudeProjectDir(home: string, cwd: string): string {
  const encoded = resolve(cwd).replaceAll('/', '-');
  return join(home, '.claude', 'projects', encoded);
}

export function grokSessionRoot(home: string, cwd: string): string {
  return join(home, '.grok', 'sessions', encodeURIComponent(resolve(cwd)));
}

export function parseClaudeRecord(raw: unknown): ParsedRecord | null {
  if (!isRecord(raw)) return null;
  const type = stringOf(raw['type']);
  const timestamp = stringOf(raw['timestamp']) || undefined;
  const sessionId = stringOf(raw['sessionId']) || undefined;
  if (type === 'assistant') {
    const message = isRecord(raw['message']) ? raw['message'] : {};
    const parts = Array.isArray(message['content']) ? message['content'] : [];
    const texts: string[] = [];
    const tools: string[] = [];
    let activity: RuntimeActivity = 'thinking';
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const partType = stringOf(part['type']);
      if (partType === 'thinking' || partType === 'reasoning') {
        activity = 'thinking';
      } else if (partType === 'tool_use' || partType === 'toolUse') {
        const name = stringOf(part['name']) || 'tool';
        tools.push(name);
        activity = activityForTool(name);
      } else if (partType === 'text') {
        const text = stringOf(part['text']);
        if (text) texts.push(text);
        if (activity === 'thinking') activity = 'writing';
      }
    }
    if (tools.length > 0) {
      return {
        stream: true,
        kind: 'tool',
        title: `Using ${tools.join(', ')}`,
        body: clip(tools.map((name) => name).join(', ')),
        activity,
        timestamp,
        sessionId,
      };
    }
    if (texts.length > 0) {
      return {
        stream: true,
        kind: 'output',
        title: '',
        body: clip(texts.join('\n')),
        activity: 'writing',
        timestamp,
        sessionId,
      };
    }
    return { stream: false, kind: 'thought', title: '', body: '', activity: 'thinking', timestamp, sessionId };
  }
  if (type === 'user') {
    const message = isRecord(raw['message']) ? raw['message'] : {};
    const body = contentText(message['content']);
    if (!body || body.startsWith('<') || body.length > 2_000) return null;
    return {
      stream: true,
      kind: 'output',
      title: 'Received a prompt',
      body: clip(body),
      timestamp,
      sessionId,
    };
  }
  return null;
}

export function parseGrokEventRecord(raw: unknown): ParsedRecord | null {
  if (!isRecord(raw)) return null;
  const type = stringOf(raw['type']);
  const timestamp = stringOf(raw['ts']) || undefined;
  const sessionId = stringOf(raw['session_id']) || undefined;
  if (type === 'phase_changed') {
    const phase = stringOf(raw['phase']);
    return {
      stream: false,
      kind: 'thought',
      title: phase,
      body: '',
      activity: activityForPhase(phase),
      timestamp,
      sessionId,
    };
  }
  if (type === 'tool_started') {
    const name = stringOf(raw['tool_name']) || 'tool';
    return {
      stream: true,
      kind: 'tool',
      title: `Using ${name}`,
      body: name,
      activity: activityForTool(name),
      timestamp,
      sessionId,
    };
  }
  if (type === 'tool_completed') {
    const name = stringOf(raw['tool_name']) || 'tool';
    const outcome = stringOf(raw['outcome']);
    return {
      stream: true,
      kind: 'tool',
      title: outcome === 'success' ? `Finished ${name}` : `${name} failed`,
      body: name,
      activity: 'thinking',
      timestamp,
      sessionId,
    };
  }
  if (type === 'turn_started') {
    return { stream: false, kind: 'thought', title: 'Turn started', body: '', activity: 'thinking', timestamp, sessionId };
  }
  if (type === 'turn_ended') {
    return { stream: false, kind: 'thought', title: 'Turn ended', body: '', activity: 'idle', timestamp, sessionId };
  }
  if (type === 'first_token') {
    return { stream: false, kind: 'thought', title: '', body: '', activity: 'thinking', timestamp, sessionId };
  }
  return null;
}

export function parseGrokChatRecord(raw: unknown): ParsedRecord | null {
  if (!isRecord(raw)) return null;
  const type = stringOf(raw['type']);
  if (type === 'assistant') {
    const body = contentText(raw['content']);
    const calls = Array.isArray(raw['tool_calls']) ? raw['tool_calls'] : [];
    const tools = calls
      .map((call) => (isRecord(call) ? stringOf(call['name']) : ''))
      .filter((name) => name.length > 0);
    if (body) {
      return {
        stream: true,
        kind: 'output',
        title: '',
        body: clip(body),
        activity: tools.length > 0 ? activityForTool(tools[0] ?? 'tool') : 'writing',
      };
    }
    if (tools.length > 0) {
      return {
        stream: true,
        kind: 'tool',
        title: `Using ${tools.join(', ')}`,
        body: tools.join(', '),
        activity: activityForTool(tools[0] ?? 'tool'),
      };
    }
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(raw['summary']) ? raw['summary'] : [];
    const text = summary
      .map((part) => (isRecord(part) ? stringOf(part['text']) : ''))
      .filter(Boolean)
      .join('\n');
    if (!text) return { stream: false, kind: 'thought', title: '', body: '', activity: 'thinking' };
    return { stream: true, kind: 'thought', title: 'Thinking', body: clip(text), activity: 'thinking' };
  }
  return null;
}

export function parseCodexRecord(raw: unknown): ParsedRecord | null {
  if (!isRecord(raw)) return null;
  const type = stringOf(raw['type']);
  const timestamp = stringOf(raw['timestamp']) || undefined;
  const payload = isRecord(raw['payload']) ? raw['payload'] : {};
  if (type === 'event_msg') {
    const eventType = stringOf(payload['type']);
    if (eventType === 'task_started') {
      return { stream: false, kind: 'thought', title: 'Turn started', body: '', activity: 'thinking', timestamp };
    }
    if (eventType === 'task_complete') {
      return { stream: false, kind: 'thought', title: 'Turn ended', body: '', activity: 'idle', timestamp };
    }
    return null;
  }
  if (type !== 'response_item') return null;
  const payloadType = stringOf(payload['type']);
  const role = stringOf(payload['role']);
  if (payloadType === 'reasoning') {
    const summary = Array.isArray(payload['summary']) ? payload['summary'] : [];
    const text = summary
      .map((part) => (isRecord(part) ? stringOf(part['text']) : ''))
      .filter(Boolean)
      .join('\n');
    return {
      stream: Boolean(text),
      kind: 'thought',
      title: 'Thinking',
      body: clip(text),
      activity: 'thinking',
      timestamp,
    };
  }
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const name = stringOf(payload['name']) || stringOf(payload['tool_name']) || 'tool';
    return {
      stream: true,
      kind: 'tool',
      title: `Using ${name}`,
      body: name,
      activity: activityForTool(name),
      timestamp,
    };
  }
  if (payloadType === 'message' && (role === 'assistant' || role === '')) {
    const body = contentText(payload['content']);
    if (!body) return { stream: false, kind: 'output', title: '', body: '', activity: 'writing', timestamp };
    return { stream: true, kind: 'output', title: '', body: clip(body), activity: 'writing', timestamp };
  }
  return null;
}

export class RuntimeObserver {
  private nextId = 1;
  private readonly events: RuntimeEvent[] = [];
  private readonly offsets = new Map<string, number>();
  private readonly seenFiles = new Set<string>();
  private readonly lastPresence = new Map<ModelAgentId, RuntimePresence>();
  private readonly lastActivityAt = new Map<ModelAgentId, number>();
  private readonly lastActivity = new Map<ModelAgentId, RuntimeActivity>();
  private readonly lastSummary = new Map<ModelAgentId, string>();
  private readonly lastSession = new Map<ModelAgentId, string>();
  private readonly lastPid = new Map<ModelAgentId, number>();
  private readonly lastCwd = new Map<ModelAgentId, string>();
  private readonly disconnectedAt = new Map<ModelAgentId, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly host: ObserveHost) {}

  start(intervalMs = 400): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A poll failure must not take down the daemon.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): RuntimeView {
    const now = this.host.now();
    const scoped = this.scopedPaths();
    const processes = this.discoverProcesses(scoped);
    const sidecars = this.discoverSidecars(scoped, processes);

    for (const agent of MODEL_AGENTS) {
      const live = processes.get(agent) ?? sidecars.get(agent)?.process ?? null;
      const sessionId = sidecars.get(agent)?.sessionId ?? null;
      const nativeStatus = sidecars.get(agent)?.status ?? null;
      this.followTranscripts(agent, live, sessionId, now);

      const recent = (this.lastActivityAt.get(agent) ?? 0) > now - WORKING_MS;
      const working = nativeStatus === 'working' || nativeStatus === 'busy' || recent;
      let presence: RuntimePresence;
      if (live) {
        this.disconnectedAt.delete(agent);
        this.lastPid.set(agent, live.pid);
        this.lastCwd.set(agent, live.cwd);
        presence = working ? 'working' : 'connected';
      } else if (this.lastPid.has(agent) || this.lastPresence.get(agent) === 'connected' || this.lastPresence.get(agent) === 'working') {
        const since = this.disconnectedAt.get(agent) ?? now;
        if (!this.disconnectedAt.has(agent)) this.disconnectedAt.set(agent, now);
        presence = now - since < DISCONNECTED_HOLD_MS ? 'disconnected' : 'not_connected';
        if (presence === 'not_connected') {
          this.lastPid.delete(agent);
          this.lastCwd.delete(agent);
        }
      } else {
        presence = 'not_connected';
      }

      if (presence === 'working') {
        this.lastActivity.set(agent, this.lastActivity.get(agent) ?? 'thinking');
        this.lastSummary.set(agent, this.lastSummary.get(agent) ?? summaryFor(this.lastActivity.get(agent) ?? 'thinking'));
      } else if (presence === 'connected') {
        this.lastActivity.set(agent, 'idle');
        this.lastSummary.set(agent, 'Connected. Idle.');
      } else if (presence === 'disconnected') {
        this.lastActivity.delete(agent);
        this.lastSummary.set(agent, 'Disconnected.');
      } else {
        this.lastActivity.delete(agent);
        this.lastSummary.set(agent, 'Not connected.');
      }

      const previous = this.lastPresence.get(agent);
      if (previous !== presence && (presence === 'connected' || presence === 'working' || presence === 'disconnected')) {
        if (previous === 'not_connected' || previous === undefined || presence === 'disconnected') {
          this.pushEvent(agent, {
            stream: true,
            kind: 'presence',
            title: presence === 'disconnected' ? 'Disconnected' : 'Connected',
            body: live ? `pid ${live.pid}` : '',
            timestamp: new Date(now).toISOString(),
          });
        }
      }
      this.lastPresence.set(agent, presence);
      if (sessionId) this.lastSession.set(agent, sessionId);
    }

    return this.view();
  }

  view(): RuntimeView {
    return {
      runtimes: MODEL_AGENTS.map((agent) => this.project(agent)),
      events: this.events.slice(-MAX_EVENTS),
      cursor: this.nextId - 1,
    };
  }

  eventsAfter(afterId: number): RuntimeEvent[] {
    return this.events.filter((event) => event.id > afterId).slice(-MAX_EVENTS);
  }

  private project(agent: ModelAgentId): RuntimeAgentState {
    const presence = this.lastPresence.get(agent) ?? 'not_connected';
    return {
      agent_id: agent,
      presence,
      activity: presence === 'not_connected' || presence === 'disconnected' ? null : (this.lastActivity.get(agent) ?? 'idle'),
      summary: this.lastSummary.get(agent) ?? (presence === 'not_connected' ? 'Not connected.' : 'Connected. Idle.'),
      pid: this.lastPid.get(agent) ?? null,
      cwd: this.lastCwd.get(agent) ?? null,
      native_session_id: this.lastSession.get(agent) ?? null,
      last_observed_at: this.lastActivityAt.has(agent) ? new Date(this.lastActivityAt.get(agent) ?? 0).toISOString() : null,
    };
  }

  private scopedPaths(): string[] {
    const roots = [resolve(this.host.repoRoot()), ...this.host.worktrees().map((tree) => resolve(tree.path))];
    return [...new Set(roots)];
  }

  private pathInScope(cwd: string, scoped: string[]): boolean {
    const resolved = resolve(cwd);
    return scoped.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`));
  }

  private discoverProcesses(scoped: string[]): Map<ModelAgentId, ObservedProcess> {
    const found = new Map<ModelAgentId, ObservedProcess>();
    for (const pid of this.host.listProcPids()) {
      const process = this.host.processOf(pid);
      if (!process || !this.pathInScope(process.cwd, scoped)) continue;
      const agent = classifyNativeProcess(process);
      if (!agent) continue;
      const existing = found.get(agent);
      const worktrees = this.host.worktrees();
      const thisIsWorktree = worktrees.some((tree) => tree.agent_id === agent && resolve(process.cwd) === resolve(tree.path));
      const existingIsWorktree =
        existing !== undefined &&
        worktrees.some((tree) => tree.agent_id === agent && resolve(existing.cwd) === resolve(tree.path));
      if (!existing || (thisIsWorktree && !existingIsWorktree)) found.set(agent, process);
    }
    return found;
  }

  private discoverSidecars(
    scoped: string[],
    processes: Map<ModelAgentId, ObservedProcess>,
  ): Map<ModelAgentId, { sessionId?: string; status?: string; process?: ObservedProcess }> {
    const found = new Map<ModelAgentId, { sessionId?: string; status?: string; process?: ObservedProcess }>();
    this.discoverClaudeSidecars(scoped, processes, found);
    this.discoverGrokSidecars(scoped, processes, found);
    this.discoverCodexSidecars(scoped, processes, found);
    return found;
  }

  private discoverClaudeSidecars(
    scoped: string[],
    processes: Map<ModelAgentId, ObservedProcess>,
    found: Map<ModelAgentId, { sessionId?: string; status?: string; process?: ObservedProcess }>,
  ): void {
    const live = processes.get('claude');
    const dir = join(this.host.home(), '.claude', 'sessions');
    const candidates: Array<{
      sessionId?: string;
      status?: string;
      process?: ObservedProcess;
      pid: number;
      updatedAt: number;
    }> = [];
    for (const name of this.host.readDir(dir) ?? []) {
      if (!name.endsWith('.json')) continue;
      const parsed = parseJson(this.host.readFile(join(dir, name)));
      if (!isRecord(parsed)) continue;
      const cwd = stringOf(parsed['cwd']);
      if (!cwd || !this.pathInScope(cwd, scoped)) continue;
      const pid = Number(parsed['pid']);
      if (!Number.isInteger(pid)) continue;
      const process = this.host.processOf(String(pid));
      const status = stringOf(parsed['status']);
      candidates.push({
        sessionId: stringOf(parsed['sessionId']) || undefined,
        status: status === 'idle' ? 'idle' : status || undefined,
        process: process ?? undefined,
        pid,
        updatedAt: Number(parsed['updatedAt'] ?? parsed['startedAt'] ?? 0) || 0,
      });
    }
    const matching = live
      ? candidates.filter((row) => row.pid === live.pid && row.process)
      : candidates.filter((row) => row.process);
    if (matching.length === 0) return;
    const selected = [...matching].sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
      return (left.sessionId ?? '').localeCompare(right.sessionId ?? '');
    })[0];
    if (!selected) return;
    found.set('claude', {
      sessionId: selected.sessionId,
      status: selected.status,
      process: selected.process ?? live,
    });
  }

  private discoverGrokSidecars(
    scoped: string[],
    processes: Map<ModelAgentId, ObservedProcess>,
    found: Map<ModelAgentId, { sessionId?: string; status?: string; process?: ObservedProcess }>,
  ): void {
    const live = processes.get('grok');
    const parsed = parseJson(this.host.readFile(join(this.host.home(), '.grok', 'active_sessions.json')));
    if (!Array.isArray(parsed)) return;
    const candidates: Array<{ sessionId?: string; process?: ObservedProcess; pid: number; openedAt: number }> = [];
    for (const row of parsed) {
      if (!isRecord(row)) continue;
      const cwd = stringOf(row['cwd']);
      if (!cwd || !this.pathInScope(cwd, scoped)) continue;
      const pid = Number(row['pid']);
      if (!Number.isInteger(pid)) continue;
      const process = this.host.processOf(String(pid));
      const opened = Date.parse(stringOf(row['opened_at']));
      candidates.push({
        sessionId: stringOf(row['session_id']) || undefined,
        process: process ?? undefined,
        pid,
        openedAt: Number.isNaN(opened) ? 0 : opened,
      });
    }
    const matching = live
      ? candidates.filter((row) => row.pid === live.pid && row.process)
      : candidates.filter((row) => row.process);
    if (matching.length === 0) return;
    const selected = [...matching].sort((left, right) => {
      if (left.openedAt !== right.openedAt) return right.openedAt - left.openedAt;
      return (left.sessionId ?? '').localeCompare(right.sessionId ?? '');
    })[0];
    if (!selected) return;
    found.set('grok', { sessionId: selected.sessionId, process: selected.process ?? live });
  }

  private discoverCodexSidecars(
    scoped: string[],
    processes: Map<ModelAgentId, ObservedProcess>,
    found: Map<ModelAgentId, { sessionId?: string; status?: string; process?: ObservedProcess }>,
  ): void {
    const live = processes.get('codex');
    const newest = this.newestCodexRollout(scoped, live?.cwd ?? null);
    if (!newest) return;
    found.set('codex', { ...(found.get('codex') ?? {}), sessionId: newest.sessionId, process: live });
  }

  private followTranscripts(
    agent: ModelAgentId,
    live: ObservedProcess | null,
    sessionId: string | null,
    now: number,
  ): void {
    if (!live) return;
    for (const path of this.transcriptPaths(agent, live, sessionId)) {
      this.consumeFile(agent, path, now);
    }
  }

  private transcriptPaths(agent: ModelAgentId, live: ObservedProcess, sessionId: string | null): string[] {
    if (agent === 'claude') {
      if (!sessionId) return [];
      const dir = claudeProjectDir(this.host.home(), live.cwd);
      return (this.host.readDir(dir) ?? [])
        .filter((name) => name.endsWith('.jsonl') && name.startsWith(sessionId))
        .sort()
        .map((name) => join(dir, name));
    }
    if (agent === 'grok') {
      if (!sessionId) return [];
      const root = join(grokSessionRoot(this.host.home(), live.cwd), sessionId);
      return [join(root, 'events.jsonl'), join(root, 'chat_history.jsonl')];
    }
    const newest = this.newestCodexRollout(this.scopedPaths(), live.cwd);
    return newest ? [newest.path] : [];
  }

  private newestCodexRollout(
    scoped: string[],
    processCwd: string | null,
  ): { path: string; sessionId?: string } | null {
    if (!processCwd) return null;
    const wanted = resolve(processCwd);
    const root = join(this.host.home(), '.codex', 'sessions');
    const stamp = new Date(this.host.now());
    const candidates: Array<{ path: string; sessionId?: string; timestamp: number }> = [];
    for (const delta of [0, 1, 2]) {
      const day = new Date(stamp.getTime() - delta * 86_400_000);
      const dir = join(
        root,
        String(day.getUTCFullYear()),
        String(day.getUTCMonth() + 1).padStart(2, '0'),
        String(day.getUTCDate()).padStart(2, '0'),
      );
      for (const name of this.host.readDir(dir) ?? []) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        const first = firstJsonLine(this.host.readFile(path));
        if (!isRecord(first)) continue;
        const payload = isRecord(first['payload']) ? first['payload'] : first;
        const cwd = stringOf(payload['cwd']);
        if (!cwd || resolve(cwd) !== wanted || !this.pathInScope(cwd, scoped)) continue;
        candidates.push({
          path,
          sessionId: stringOf(payload['session_id']) || stringOf(payload['id']) || undefined,
          timestamp: rolloutSortKey(path, first, payload),
        });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => {
      if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
      return left.path.localeCompare(right.path);
    });
    return candidates[0] ?? null;
  }

  private consumeFile(agent: ModelAgentId, path: string, now: number): void {
    const known = this.offsets.has(path);
    if (!known) {
      const probe = this.host.readPartial(path, Number.MAX_SAFE_INTEGER);
      if (!probe) return;
      const start = Math.max(0, probe.size - FIRST_LOOKBACK_BYTES);
      this.offsets.set(path, start);
    }
    const offset = this.offsets.get(path) ?? 0;
    const chunk = this.host.readPartial(path, offset);
    if (!chunk) return;
    if (chunk.size < offset) {
      this.offsets.delete(path);
      this.seenFiles.delete(path);
      return this.consumeFile(agent, path, now);
    }
    const parsed = takeCompleteLines(chunk.data);
    const records: ParsedRecord[] = [];
    for (const line of parsed.lines) {
      const record = parseTranscriptLine(agent, path, line);
      if (record) records.push(record);
    }
    const emit = this.seenFiles.has(path) ? records : records.slice(-FIRST_EMIT_PER_FILE);
    for (const record of emit) this.applyRecord(agent, record, now);
    this.offsets.set(path, offset + parsed.consumed);
    this.seenFiles.add(path);
  }

  private applyRecord(agent: ModelAgentId, record: ParsedRecord, now: number): void {
    if (record.activity) {
      this.lastActivity.set(agent, record.activity);
      const at = record.timestamp ? Date.parse(record.timestamp) : now;
      const when = Number.isNaN(at) ? now : at;
      if (record.activity !== 'idle') this.lastActivityAt.set(agent, when);
      this.lastSummary.set(agent, summaryFor(record.activity, record.title || record.body));
    }
    if (record.sessionId) this.lastSession.set(agent, record.sessionId);
    if (record.stream) this.pushEvent(agent, record);
  }

  private pushEvent(agent: ModelAgentId, record: ParsedRecord): void {
    if (!record.stream) return;
    const timestamp = record.timestamp && !Number.isNaN(Date.parse(record.timestamp))
      ? new Date(record.timestamp).toISOString()
      : new Date(this.host.now()).toISOString();
    this.events.push({
      id: this.nextId,
      agent_id: agent,
      kind: record.kind,
      title: record.title,
      body: record.body,
      timestamp,
    });
    this.nextId += 1;
    if (this.events.length > MAX_EVENTS * 2) this.events.splice(0, this.events.length - MAX_EVENTS);
  }
}

function parseTranscriptLine(agent: ModelAgentId, path: string, line: string): ParsedRecord | null {
  const raw = parseJson(line);
  if (agent === 'claude') return parseClaudeRecord(raw);
  if (agent === 'codex') return parseCodexRecord(raw);
  if (path.endsWith('chat_history.jsonl')) return parseGrokChatRecord(raw);
  return parseGrokEventRecord(raw);
}

function activityForTool(name: string): RuntimeActivity {
  for (const [pattern, activity] of TOOL_ACTIVITY) {
    if (pattern.test(name)) return activity;
  }
  return 'using_tool';
}

function activityForPhase(phase: string): RuntimeActivity {
  const value = phase.toLowerCase();
  if (value.includes('idle') || value.includes('end')) return 'idle';
  if (value.includes('wait') && value.includes('user')) return 'waiting';
  if (value.includes('think') || value.includes('waiting_for_model') || value.includes('waiting_model')) return 'thinking';
  if (value.includes('tool') || value.includes('command')) return 'using_tool';
  if (value.includes('writ') || value.includes('compos')) return 'writing';
  return 'thinking';
}

function summaryFor(activity: RuntimeActivity, detail = ''): string {
  const hint = detail.replace(/^(Using|Finished|Thinking)\s+/i, '').trim();
  switch (activity) {
    case 'thinking':
      return 'Thinking.';
    case 'reading':
      return hint ? `Reading ${hint}.` : 'Reading files.';
    case 'running_command':
      return 'Running a command.';
    case 'using_tool':
      return hint ? `Using ${hint}.` : 'Using tools.';
    case 'writing':
      return 'Writing.';
    case 'reviewing':
      return 'Reviewing the work.';
    case 'verifying':
      return 'Checking the work.';
    case 'waiting':
      return 'Waiting.';
    default:
      return 'Connected. Idle.';
  }
}

function idleState(agent_id: ModelAgentId, presence: RuntimePresence): RuntimeAgentState {
  return {
    agent_id,
    presence,
    activity: presence === 'connected' ? 'idle' : null,
    summary: presence === 'connected' ? 'Connected. Idle.' : presence === 'disconnected' ? 'Disconnected.' : 'Not connected.',
    pid: null,
    cwd: null,
    native_session_id: null,
    last_observed_at: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clip(value: string, max = MAX_BODY): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      return stringOf(part['text']) || stringOf(part['thinking']);
    })
    .filter(Boolean)
    .join('\n');
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstJsonLine(text: string | null): unknown {
  if (!text) return null;
  const line = text.split('\n').find((row) => row.trim().length > 0);
  return line ? parseJson(line) : null;
}

export function takeCompleteLines(chunk: Buffer): { lines: string[]; consumed: number } {
  const newline = chunk.lastIndexOf(0x0a);
  if (newline < 0) return { lines: [], consumed: 0 };
  const complete = chunk.subarray(0, newline + 1);
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < complete.length; index += 1) {
    if (complete[index] !== 0x0a) continue;
    const line = complete.subarray(start, index);
    if (line.length > 0) lines.push(line.toString('utf8'));
    start = index + 1;
  }
  return { lines, consumed: complete.length };
}

function rolloutSortKey(path: string, first: Record<string, unknown>, payload: Record<string, unknown>): number {
  const stamped = Date.parse(stringOf(first['timestamp']) || stringOf(payload['timestamp']));
  if (!Number.isNaN(stamped)) return stamped;
  const match = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(basename(path));
  if (!match?.[1]) return 0;
  return Date.parse(match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')) || 0;
}

