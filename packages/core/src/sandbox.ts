import { posix } from 'node:path';
import {
  type ExitReason,
  type FileContents,
  type NetworkPolicy,
  type Package,
  type PackageSource,
  type Process,
  type Sandbox,
  Wasmer,
  WasmerError,
} from '@wasmer/sdk/node';

/** Pinned so results are reproducible; bundles bash plus a coreutils set. */
export const DEFAULT_SHELL_PACKAGE = 'wasmer/bash@=1.0.25';

/**
 * The only guest directory that persists between commands. Every other path
 * (`/tmp`, `/usr/local`, ...) is a fresh filesystem for each process, and
 * `sandbox.fs` rejects paths outside it.
 */
export const WORKSPACE_DIR = '/workspace';

/** Default `HOME`, inside the workspace so that dotfiles and tool state persist. */
export const DEFAULT_HOME = `${WORKSPACE_DIR}/.home`;

export interface ExecLimits {
  /** Wall-clock limit per command. The guest is killed when it elapses. */
  readonly timeoutMs: number;
  /** Captured bytes kept per stream (stdout and stderr each). The rest is discarded. */
  readonly outputBytes: number;
}

export const DEFAULT_LIMITS: ExecLimits = { timeoutMs: 60_000, outputBytes: 1024 * 1024 };

export interface WasmerSandboxOptions {
  /**
   * Share a client (package cache, workers) across sandboxes. A client passed
   * here is not closed by {@link WasmerSandbox.close}; one created internally is.
   */
  readonly wasmer?: Wasmer;
  /** Packages installed alongside the shell package, e.g. `python/python@=3.13.20`. */
  readonly packages?: readonly PackageSource[];
  /** Package providing the shell used for command strings. */
  readonly shellPackage?: PackageSource;
  /** Command in `shellPackage` that interprets command strings. Defaults to `bash`. */
  readonly shellCommand?: string;
  /** Written under `/workspace`. The only host data a guest can see. */
  readonly files?: Readonly<Record<string, FileContents>>;
  /**
   * Base guest environment. The host environment is never inherited. `HOME`
   * defaults to {@link DEFAULT_HOME}, which is created if missing.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Defaults to `{ mode: 'disabled' }`. */
  readonly network?: NetworkPolicy;
  readonly limits?: Partial<ExecLimits>;
  /** Grace period between asking an aborted command to exit and killing it. */
  readonly abortGracePeriodMs?: number;
  /** Aborts package acquisition and sandbox creation. */
  readonly signal?: AbortSignal;
}

export interface CommandOptions {
  /** Guest path, absolute or relative to `/workspace`. Defaults to `/workspace`. */
  readonly cwd?: string;
  /** Merged over the sandbox environment; these values win. */
  readonly env?: Readonly<Record<string, string>>;
  /** Aborting terminates the guest process, and the result then rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
}

export interface ExecOptions extends CommandOptions {
  /** Written to the command's stdin, then closed. Without it stdin is closed. */
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
}

export interface SpawnOptions extends CommandOptions {
  /** No limit by default: spawned processes are expected to be long-running. */
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  /** `exited` when the command ended on its own, whatever its status. */
  readonly reason: ExitReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  readonly durationMs: number;
}

/** A live process. Consume both streams: unread output can stall the guest. */
export interface SpawnedCommand {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Rejects with `signal.reason` if the command was aborted. */
  wait(): Promise<{ readonly exitCode: number; readonly reason: ExitReason }>;
  /** Forced termination. Idempotent. */
  kill(): Promise<void>;
}

/** Exact package identities resolved for this sandbox, e.g. `wasmer/bash@1.0.25`. */
export interface SandboxProvenance {
  readonly packages: readonly string[];
  readonly network: NetworkPolicy['mode'];
}

/** A file path that the sandbox cannot persist or expose through its filesystem API. */
export class SandboxPathError extends Error {
  override readonly name = 'SandboxPathError';
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} is outside ${WORKSPACE_DIR}. Only ${WORKSPACE_DIR} persists between ` +
        'commands in a Wasmer sandbox, and only it is reachable through the file API.',
    );
    this.path = path;
  }
}

/**
 * A Wasmer sandbox that runs shell command strings, the shape agent-framework
 * sandbox interfaces expect. Exit statuses are results, not errors: `exec`
 * rejects only for abort or SDK failures.
 */
export class WasmerSandbox {
  readonly #wasmer: Wasmer;
  readonly #ownsClient: boolean;
  readonly #limits: ExecLimits;
  readonly #abortGracePeriodMs: number;
  #closed = false;

  /** The underlying SDK sandbox, for capabilities this wrapper does not cover. */
  readonly sdk: Sandbox;
  readonly provenance: SandboxProvenance;
  /** Where commands run when no `cwd` is given. */
  readonly defaultWorkingDirectory = WORKSPACE_DIR;
  /** The guest `HOME`. */
  readonly home: string;

  private constructor(init: {
    wasmer: Wasmer;
    ownsClient: boolean;
    sdk: Sandbox;
    limits: ExecLimits;
    abortGracePeriodMs: number;
    provenance: SandboxProvenance;
    home: string;
  }) {
    this.#wasmer = init.wasmer;
    this.#ownsClient = init.ownsClient;
    this.sdk = init.sdk;
    this.#limits = init.limits;
    this.#abortGracePeriodMs = init.abortGracePeriodMs;
    this.provenance = init.provenance;
    this.home = init.home;
  }

  static async create(options: WasmerSandboxOptions = {}): Promise<WasmerSandbox> {
    const limits = resolveLimits(options.limits);
    const abortGracePeriodMs = options.abortGracePeriodMs ?? 500;
    assertNonNegativeInteger('abortGracePeriodMs', abortGracePeriodMs);
    const network = options.network ?? { mode: 'disabled' };
    const env = { HOME: DEFAULT_HOME, ...options.env };
    const signal = options.signal;

    const ownsClient = options.wasmer === undefined;
    const wasmer = options.wasmer ?? new Wasmer();
    let sdk: Sandbox | undefined;
    try {
      signal?.throwIfAborted();
      const [shell, ...extra] = await wasmer.packages.loadMany(
        [options.shellPackage ?? DEFAULT_SHELL_PACKAGE, ...(options.packages ?? [])],
        signal ? { signal } : {},
      );
      const packages = [shell, ...extra] as Package[];
      sdk = await wasmer.sandboxes.create({
        packages,
        shell: (shell as Package).command(options.shellCommand ?? 'bash'),
        files: options.files ?? {},
        env,
        network,
        ...(signal ? { signal } : {}),
      });
      if (isInWorkspace(env.HOME)) await sdk.fs.mkdir(env.HOME, { recursive: true });
      return new WasmerSandbox({
        wasmer,
        ownsClient,
        sdk,
        limits,
        abortGracePeriodMs,
        provenance: { packages: packages.map((pkg) => pkg.id), network: network.mode },
        home: env.HOME,
      });
    } catch (error) {
      await sdk?.close();
      if (ownsClient) await wasmer.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Absolute guest path; relative paths resolve against `/workspace`. */
  resolvePath(path: string): string {
    return posix.resolve(WORKSPACE_DIR, path);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? this.#limits.timeoutMs;
    const outputBytes = options.outputBytes ?? this.#limits.outputBytes;
    assertPositiveInteger('timeoutMs', timeoutMs);
    assertPositiveInteger('outputBytes', outputBytes);

    const started = performance.now();
    const guest = await this.#command(command, options).spawn({
      stdin: options.stdin === undefined ? 'closed' : 'pipe',
      stdout: 'capture',
      stderr: 'capture',
      timeoutMs,
      outputBytes,
    });

    const detach = this.#terminateOnAbort(guest, signal);
    try {
      // Feed stdin concurrently: a guest that never reads must not block wait().
      const feeding = options.stdin === undefined ? undefined : feed(guest, options.stdin);
      const output = await guest.wait();
      await feeding;
      signal?.throwIfAborted();
      return {
        exitCode: output.exitCode,
        reason: output.reason,
        stdout: output.stdout.text(),
        stderr: output.stderr.text(),
        truncated: { stdout: output.stdout.truncated, stderr: output.stderr.truncated },
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      detach();
    }
  }

  /** Start a command whose output is streamed rather than captured. Stdin is closed. */
  async spawn(command: string, options: SpawnOptions = {}): Promise<SpawnedCommand> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (options.timeoutMs !== undefined) assertPositiveInteger('timeoutMs', options.timeoutMs);

    const guest = await this.#command(command, options).spawn({
      stdin: 'closed',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const detach = this.#terminateOnAbort(guest, signal);
    const exited = guest.wait().finally(detach);
    // Callers may never call wait(); keep an abandoned rejection from going unhandled.
    exited.catch(() => {});

    return {
      pid: guest.id,
      stdout: requireStream(guest.stdout, 'stdout').toReadableStream(),
      stderr: requireStream(guest.stderr, 'stderr').toReadableStream(),
      async wait() {
        const output = await exited;
        signal?.throwIfAborted();
        return { exitCode: output.exitCode, reason: output.reason };
      },
      async kill() {
        try {
          await guest.kill();
        } catch (error) {
          // Already gone: the process exited or its sandbox closed.
          if (!isGone(error)) throw error;
        }
      },
    };
  }

  /** File contents, or `null` if nothing exists at `path`. */
  async readFile(path: string): Promise<Uint8Array | null> {
    const resolved = this.#workspacePath(path);
    try {
      return await this.sdk.fs.readFile(resolved);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Creates parent directories and overwrites any existing file. */
  async writeFile(path: string, contents: FileContents): Promise<void> {
    const resolved = this.#workspacePath(path);
    await this.sdk.fs.mkdir(posix.dirname(resolved), { recursive: true });
    await this.sdk.fs.writeFile(resolved, contents);
  }

  /** Idempotent. Running commands end with reason `terminated`. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.sdk.close();
    } finally {
      if (this.#ownsClient) await this.#wasmer.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #command(command: string, options: CommandOptions) {
    return this.sdk.shell(command, {
      ...(options.cwd !== undefined ? { cwd: this.resolvePath(options.cwd) } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  }

  #workspacePath(path: string): string {
    const resolved = this.resolvePath(path);
    if (!isInWorkspace(resolved)) throw new SandboxPathError(resolved);
    return resolved;
  }

  /** Returns a function that detaches the listener. */
  #terminateOnAbort(guest: Process, signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {};
    const onAbort = () => {
      guest.terminate({ gracePeriodMs: this.#abortGracePeriodMs }).catch(() => {
        // Already exited, or the sandbox closed underneath it: nothing left to stop.
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // The abort may have fired while the process was spawning.
    if (signal.aborted) onAbort();
    return () => signal.removeEventListener('abort', onAbort);
  }
}

export function resolveLimits(overrides: Partial<ExecLimits> = {}): ExecLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  assertPositiveInteger('timeoutMs', limits.timeoutMs);
  assertPositiveInteger('outputBytes', limits.outputBytes);
  return limits;
}

function isInWorkspace(path: string): boolean {
  return path === WORKSPACE_DIR || path.startsWith(`${WORKSPACE_DIR}/`);
}

// The SDK has no distinct code for a missing file: it reports FILESYSTEM_ERROR
// with "entry not found" in the message (@wasmer/sdk 0.18.0).
function isNotFound(error: unknown): boolean {
  return WasmerError.is(error, 'FILESYSTEM_ERROR') && /entry not found/i.test(error.message);
}

function isGone(error: unknown): boolean {
  return WasmerError.is(error, 'SANDBOX_CLOSED') || WasmerError.is(error, 'PROCESS_EXITED');
}

function requireStream<T>(stream: T | null, name: string): T {
  if (stream === null) throw new Error(`Wasmer did not provide a piped ${name} stream`);
  return stream;
}

async function feed(guest: Process, stdin: string | Uint8Array): Promise<void> {
  const writer = guest.stdin;
  if (!writer) return;
  try {
    await writer.write(typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin);
    await writer.close();
  } catch {
    // The guest exited without draining stdin; its exit status says what happened.
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}
