import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export interface RepositoryBinding {
  identity: string;
  rootPath: string;
  commonGitDir: string;
  objectFormat: string;
}

export interface ManagedWorktree {
  agentId: string;
  branch: string;
  path: string;
  headCommit: string;
}

export interface VerificationExecution {
  commit: string;
  commandArgv: string[];
  exitCode: number;
}

export interface RepositoryBlob {
  commit: string;
  identity: string;
  contents: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? '').trim()
        : '';
    throw new GitError(stderr || `git ${args.join(' ')} failed`, 'git_command_failed');
  }
}

/**
 * The working tree the caller is standing in, which is a managed agent worktree rather than the
 * main one whenever a model runs the CLI from its own checkout.
 */
export function worktreeRoot(startPath: string): string {
  const cwd = resolve(startPath);
  try {
    return realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new GitError(`${cwd} is not inside a Git working tree`, 'repository_not_found');
  }
}

function mainWorktreePath(cwd: string): string {
  const list = git(cwd, ['worktree', 'list', '--porcelain']);
  const firstLine = list.split('\n').find((line) => line.startsWith('worktree '));
  if (!firstLine) throw new GitError('repository has no main worktree', 'repository_not_found');
  return realpathSync(firstLine.slice('worktree '.length));
}

/**
 * Resolves to the command's exit status. A command that cannot be launched resolves to `1` with its
 * failure reported as output, matching the previous synchronous behavior: an unlaunchable check is
 * failing evidence, not a harness crash.
 */
function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onOutput?.('stdout', chunk));
    child.stderr.on('data', (chunk: string) => onOutput?.('stderr', chunk));
    child.on('error', (error) => {
      onOutput?.('stderr', `${error.message}\n`);
      resolveExit(1);
    });
    child.on('close', (code) => resolveExit(code ?? 1));
  });
}

export class GitRepository {
  readonly binding: RepositoryBinding;

  private constructor(binding: RepositoryBinding) {
    this.binding = binding;
  }

  static discover(startPath = process.cwd()): GitRepository {
    const cwd = resolve(startPath);
    let commonGitDir: string;
    try {
      commonGitDir = realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    } catch (error) {
      if (error instanceof GitError) {
        throw new GitError(`${cwd} is not inside a Git repository`, 'repository_not_found');
      }
      throw error;
    }
    const rootPath = mainWorktreePath(cwd);
    const objectFormat = git(cwd, ['rev-parse', '--show-object-format']);
    const identity = `sha256:${createHash('sha256')
      .update(`scrapgrid-repository\0${commonGitDir}\0${objectFormat}`)
      .digest('hex')}`;
    return new GitRepository({ identity, rootPath, commonGitDir, objectFormat });
  }

  headCommit(): string {
    return this.resolveCommit(git(this.binding.rootPath, ['rev-parse', 'HEAD']));
  }

  resolveCommit(claim: string): string {
    const maxLength = this.binding.objectFormat === 'sha256' ? 64 : 40;
    if (!new RegExp(`^[0-9a-fA-F]{7,${maxLength}}$`).test(claim)) {
      throw new GitError(`invalid commit SHA: ${claim}`, 'invalid_commit_sha');
    }
    let commit: string;
    try {
      commit = git(this.binding.rootPath, ['rev-parse', '--verify', `${claim}^{commit}`]).toLowerCase();
    } catch {
      throw new GitError(`commit does not exist in this repository: ${claim}`, 'unknown_commit');
    }
    const containingRefs = git(this.binding.rootPath, [
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      commit,
      'refs/',
    ]);
    if (!containingRefs) {
      throw new GitError(`commit is not reachable from this repository's refs: ${commit}`, 'foreign_commit');
    }
    return commit;
  }

  requireDescendant(baseClaim: string, candidateClaim: string): { baseCommit: string; candidateCommit: string } {
    const baseCommit = this.resolveCommit(baseClaim);
    const candidateCommit = this.resolveCommit(candidateClaim);
    const result = spawnSync(
      'git',
      ['-C', this.binding.rootPath, 'merge-base', '--is-ancestor', baseCommit, candidateCommit],
      { stdio: 'ignore', shell: false },
    );
    if (result.status === 1) {
      throw new GitError(
        `candidate ${candidateCommit} does not descend from task base ${baseCommit}`,
        'candidate_not_descendant',
      );
    }
    if (result.status !== 0) {
      throw new GitError('git merge-base --is-ancestor failed', 'git_command_failed');
    }
    return { baseCommit, candidateCommit };
  }

  readBlobAtCommit(commitClaim: string, path: string): RepositoryBlob {
    const commit = this.resolveCommit(commitClaim);
    let objectId: string;
    try {
      objectId = git(this.binding.rootPath, ['rev-parse', '--verify', `${commit}:${path}`]).toLowerCase();
    } catch {
      throw new GitError(`required repository file is missing at ${commit}: ${path}`, 'missing_repository_file');
    }
    if (git(this.binding.rootPath, ['cat-file', '-t', objectId]) !== 'blob') {
      throw new GitError(`required repository path is not a file at ${commit}: ${path}`, 'invalid_repository_file');
    }
    return {
      commit,
      identity: `${this.binding.objectFormat}:${objectId}`,
      contents: git(this.binding.rootPath, ['cat-file', '-p', objectId]),
    };
  }

  bootstrapWorktrees(rootPath: string, baseClaim: string, agentIds: string[]): ManagedWorktree[] {
    const baseCommit = this.resolveCommit(baseClaim);
    const worktreeRoot = resolve(rootPath);
    const registered = this.registeredWorktrees();

    for (const agentId of agentIds) {
      const target = resolve(worktreeRoot, agentId);
      const branch = `refs/heads/collab/${agentId}`;
      const atTarget = registered.find((item) => item.path === target);
      if (atTarget && atTarget.branch !== branch) {
        throw new GitError(`${target} is registered to ${atTarget.branch ?? 'a detached worktree'}`, 'worktree_conflict');
      }
      const branchElsewhere = registered.find((item) => item.branch === branch && item.path !== target);
      if (branchElsewhere) {
        throw new GitError(`${branch} is already checked out at ${branchElsewhere.path}`, 'worktree_conflict');
      }
      if (!atTarget && existsSync(target)) {
        throw new GitError(`${target} already exists and is not a managed Git worktree`, 'worktree_path_exists');
      }
    }

    mkdirSync(worktreeRoot, { recursive: true });

    for (const agentId of agentIds) {
      const target = resolve(worktreeRoot, agentId);
      const branch = `refs/heads/collab/${agentId}`;
      if (registered.some((item) => item.path === target && item.branch === branch)) continue;
      const shortBranch = `collab/${agentId}`;
      let branchExists = true;
      try {
        git(this.binding.rootPath, ['show-ref', '--verify', '--quiet', branch]);
      } catch {
        branchExists = false;
      }
      const args = branchExists
        ? ['worktree', 'add', target, shortBranch]
        : ['worktree', 'add', '-b', shortBranch, target, baseCommit];
      git(this.binding.rootPath, args);
    }

    return agentIds.map((agentId) => {
      const path = resolve(worktreeRoot, agentId);
      return {
        agentId,
        branch: `collab/${agentId}`,
        path,
        headCommit: git(path, ['rev-parse', 'HEAD']).toLowerCase(),
      };
    });
  }

  /**
   * Runs a verification command at an immutable commit inside a disposable detached worktree.
   *
   * `onOutput` lets the daemon stream the run back to whichever terminal asked for it while the
   * daemon itself remains the process that observes the exit code. Evidence is never reported by a
   * client.
   */
  async runAtCommit(
    commitClaim: string,
    command: string[],
    onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
  ): Promise<VerificationExecution> {
    const commit = this.resolveCommit(commitClaim);
    const executable = command[0];
    if (!executable) throw new GitError('verification command cannot be empty', 'missing_verification_command');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'scrapgrid-verify-'));
    const worktreePath = join(temporaryRoot, 'worktree');
    let added = false;
    try {
      git(this.binding.rootPath, ['worktree', 'add', '--detach', worktreePath, commit]);
      added = true;
      const checkedOutCommit = git(worktreePath, ['rev-parse', 'HEAD']).toLowerCase();
      if (checkedOutCommit !== commit) {
        throw new GitError(
          `verification worktree resolved ${checkedOutCommit} instead of ${commit}`,
          'verification_checkout_mismatch',
        );
      }
      return {
        commit,
        commandArgv: [...command],
        exitCode: await runCommand(executable, command.slice(1), worktreePath, onOutput),
      };
    } finally {
      if (added) {
        try {
          git(this.binding.rootPath, ['worktree', 'remove', '--force', worktreePath]);
        } catch {
          // The explicit temporary directory cleanup below remains scoped to this invocation.
        }
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private registeredWorktrees(): Array<{ path: string; branch?: string }> {
    const records = git(this.binding.rootPath, ['worktree', 'list', '--porcelain']).split('\n\n');
    return records.flatMap((record) => {
      const lines = record.split('\n');
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      if (!pathLine) return [];
      const branchLine = lines.find((line) => line.startsWith('branch '));
      return [{ path: resolve(pathLine.slice('worktree '.length)), branch: branchLine?.slice('branch '.length) }];
    });
  }
}
