import type { GitRepository } from './git.js';
import {
  daemonRuntimePaths,
  DaemonRuntimeError,
  readDaemonDescriptor,
  requireLiveDaemon,
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

function frameError(payload: Record<string, unknown>): DaemonRuntimeError {
  const message = typeof payload['message'] === 'string' ? payload['message'] : 'collabd rejected the operation';
  const code = typeof payload['code'] === 'string' ? payload['code'] : 'operation_failed';
  return new DaemonRuntimeError(message, code);
}

async function requestOperation(
  descriptor: DaemonDescriptor,
  operation: string,
  input: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(`${descriptor.url}/api/operations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${descriptor.agent_token}`,
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
  operation: string,
  input: Record<string, unknown> = {},
  onOutput: OutputSink = defaultSink,
): Promise<unknown> {
  const response = await requestOperation(descriptor, operation, input);
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
