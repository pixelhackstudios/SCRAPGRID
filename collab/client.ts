import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { worktreeRoot, type GitRepository } from './git.js';
import {
  daemonRuntimePaths,
  DaemonRuntimeError,
  readDaemonDescriptor,
  readSessionDescriptor,
  requireLiveDaemon,
  sessionDescriptorPath,
  type DaemonDescriptor,
} from './runtime.js';

export type OutputSink = (stream: 'stdout' | 'stderr', data: string) => void;

const defaultSink: OutputSink = (stream, data) => {
  if (stream === 'stderr') process.stderr.write(data);
  else process.stdout.write(data);
};

/**
 * Locates this repository's daemon and proves it is the right one before any request is sent.
 *
 * There is deliberately no fallback path: a client that cannot reach `collabd` fails rather than
 * opening the collaboration database itself.
 */
export function connectToDaemon(repository: GitRepository): DaemonDescriptor {
  const { descriptorPath } = daemonRuntimePaths(repository.binding.rootPath);
  return requireLiveDaemon(readDaemonDescriptor(descriptorPath), repository.binding.identity);
}

export interface ClientCredential {
  token: string;
  /** Which identity this invocation will be authenticated as. */
  principal: 'control' | string;
  source: string;
}

/**
 * Chooses which credential this invocation presents.
 *
 * A model runs the CLI from its own managed worktree, where the daemon delivered its session
 * descriptor, so it is authenticated as itself without passing a flag. The human runs it from the
 * main worktree, where no session descriptor exists, and falls back to the daemon's local control
 * credential. `COLLAB_SESSION` names a descriptor explicitly when a model is not in its worktree.
 */
export function resolveCredential(descriptor: DaemonDescriptor, startPath: string): ClientCredential {
  const explicit = process.env['COLLAB_SESSION'];
  if (explicit) {
    const path = resolve(explicit);
    const session = readSessionDescriptor(path);
    return { token: session.token, principal: session.agent_id, source: path };
  }
  const local = sessionDescriptorPath(worktreeRoot(startPath));
  if (existsSync(local)) {
    const session = readSessionDescriptor(local);
    return { token: session.token, principal: session.agent_id, source: local };
  }
  return { token: descriptor.agent_token, principal: 'control', source: 'daemon control credential' };
}

function frameError(payload: Record<string, unknown>): DaemonRuntimeError {
  const message = typeof payload['message'] === 'string' ? payload['message'] : 'collabd rejected the operation';
  const code = typeof payload['code'] === 'string' ? payload['code'] : 'operation_failed';
  return new DaemonRuntimeError(message, code);
}

async function requestOperation(
  descriptor: DaemonDescriptor,
  credential: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(`${descriptor.url}/api/operations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ operation, input }),
    });
  } catch (error) {
    throw new DaemonRuntimeError(
      `collabd at ${descriptor.url} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      'daemon_unavailable',
    );
  }
}

/**
 * Invokes one operation and consumes its newline-delimited response.
 *
 * Output frames are forwarded as they arrive, so an agent still watches its own verification run in
 * its own terminal even though the daemon is the process that ran it.
 */
export async function invokeOperation(
  descriptor: DaemonDescriptor,
  credential: string,
  operation: string,
  input: Record<string, unknown> = {},
  onOutput: OutputSink = defaultSink,
): Promise<unknown> {
  const response = await requestOperation(descriptor, credential, operation, input);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    throw new DaemonRuntimeError(
      typeof payload?.['error'] === 'string' ? payload['error'] : `collabd returned HTTP ${response.status}`,
      typeof payload?.['code'] === 'string' ? payload['code'] : 'daemon_request_failed',
    );
  }
  if (!response.body) {
    throw new DaemonRuntimeError('collabd returned an empty response stream', 'daemon_stream_incomplete');
  }

  let result: { value: unknown } | undefined;
  let failure: DaemonRuntimeError | undefined;
  const consume = (line: string): void => {
    if (line.trim().length === 0) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new DaemonRuntimeError(`collabd emitted an unreadable frame: ${line}`, 'daemon_stream_corrupt');
    }
    switch (frame['type']) {
      case 'output':
        onOutput(frame['stream'] === 'stderr' ? 'stderr' : 'stdout', String(frame['data'] ?? ''));
        return;
      case 'keepalive':
        return;
      case 'result':
        result = { value: frame['value'] };
        return;
      case 'error':
        failure = frameError(frame);
        return;
      default:
        throw new DaemonRuntimeError(`collabd emitted an unknown frame type: ${String(frame['type'])}`, 'daemon_stream_corrupt');
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    if (done) break;
  }
  consume(buffer);

  if (failure) throw failure;
  if (!result) {
    throw new DaemonRuntimeError('collabd closed the stream without a result', 'daemon_stream_incomplete');
  }
  return result.value;
}
