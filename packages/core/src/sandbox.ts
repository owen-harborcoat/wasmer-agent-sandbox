import {
  type ExitReason,
  type FileContents,
  type NetworkPolicy,
  type Package,
  type PackageSource,
  type Process,
  type Sandbox,
  Wasmer,
} from '@wasmer/sdk/node';

/** Pinned so results are reproducible; bundles bash plus a coreutils set. */
export const DEFAULT_SHELL_PACKAGE = 'wasmer/bash@=1.0.25';

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
  /** Base guest environment. The host environment is never inherited. */
  readonly env?: Readonly<Record<string, string>>;
  /** Defaults to `{ mode: 'disabled' }`. */
  readonly network?: NetworkPolicy;
  readonly limits?: Partial<ExecLimits>;
  /** Grace period between asking an aborted command to exit and killing it. */
  readonly abortGracePeriodMs?: number;
  /** Aborts package acquisition and sandbox creation. */
  readonly signal?: AbortSignal;
}

export interface ExecOptions {
  /** Guest path. Defaults to `/workspace`. */
  readonly cwd?: string;
  /** Merged over the sandbox environment; these values win. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to the command's stdin, then closed. Without it stdin is closed. */
  readonly stdin?: string | Uint8Array;
  /** Aborting terminates the guest process; `exec` then rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
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

/** Exact package identities resolved for this sandbox, e.g. `wasmer/bash@1.0.25`. */
export interface SandboxProvenance {
  readonly packages: readonly string[];
  readonly network: NetworkPolicy['mode'];
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

  private constructor(
    wasmer: Wasmer,
    ownsClient: boolean,
    sdk: Sandbox,
    limits: ExecLimits,
    abortGracePeriodMs: number,
    provenance: SandboxProvenance,
  ) {
    this.#wasmer = wasmer;
    this.#ownsClient = ownsClient;
    this.sdk = sdk;
    this.#limits = limits;
    this.#abortGracePeriodMs = abortGracePeriodMs;
    this.provenance = provenance;
  }

  static async create(options: WasmerSandboxOptions = {}): Promise<WasmerSandbox> {
    const limits = resolveLimits(options.limits);
    const abortGracePeriodMs = options.abortGracePeriodMs ?? 500;
    assertNonNegativeInteger('abortGracePeriodMs', abortGracePeriodMs);
    const network = options.network ?? { mode: 'disabled' };
    const signal = options.signal;

    const ownsClient = options.wasmer === undefined;
    const wasmer = options.wasmer ?? new Wasmer();
    try {
      signal?.throwIfAborted();
      const [shell, ...extra] = await wasmer.packages.loadMany(
        [options.shellPackage ?? DEFAULT_SHELL_PACKAGE, ...(options.packages ?? [])],
        signal ? { signal } : {},
      );
      const packages = [shell, ...extra] as Package[];
      const sdk = await wasmer.sandboxes.create({
        packages,
        shell: (shell as Package).command(options.shellCommand ?? 'bash'),
        files: options.files ?? {},
        env: options.env ?? {},
        network,
        ...(signal ? { signal } : {}),
      });
      return new WasmerSandbox(wasmer, ownsClient, sdk, limits, abortGracePeriodMs, {
        packages: packages.map((pkg) => pkg.id),
        network: network.mode,
      });
    } catch (error) {
      if (ownsClient) await wasmer.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? this.#limits.timeoutMs;
    const outputBytes = options.outputBytes ?? this.#limits.outputBytes;
    assertPositiveInteger('timeoutMs', timeoutMs);
    assertPositiveInteger('outputBytes', outputBytes);

    const started = performance.now();
    const guest = await this.sdk
      .shell(command, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      })
      .spawn({
        stdin: options.stdin === undefined ? 'closed' : 'pipe',
        stdout: 'capture',
        stderr: 'capture',
        timeoutMs,
        outputBytes,
      });

    const onAbort = () => void this.#stop(guest);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The abort may have fired while the process was spawning.
      if (signal?.aborted) onAbort();
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
      signal?.removeEventListener('abort', onAbort);
    }
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

  async #stop(guest: Process): Promise<void> {
    try {
      await guest.terminate({ gracePeriodMs: this.#abortGracePeriodMs });
    } catch {
      // Already exited, or the sandbox closed underneath it: nothing left to stop.
    }
  }
}

export function resolveLimits(overrides: Partial<ExecLimits> = {}): ExecLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  assertPositiveInteger('timeoutMs', limits.timeoutMs);
  assertPositiveInteger('outputBytes', limits.outputBytes);
  return limits;
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
