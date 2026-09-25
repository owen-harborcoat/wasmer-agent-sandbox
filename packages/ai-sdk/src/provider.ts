import { randomUUID } from 'node:crypto';
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
  type HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { WasmerSandbox, type WasmerSandboxOptions } from '@owenota1337/wasmer-sandbox-core';
import { WasmerSandboxSession } from './session.js';

export const WASMER_SANDBOX_PROVIDER_ID = 'wasmer-sandbox';

/**
 * Settings for {@link createWasmerSandbox}. Either options for a fresh
 * sandbox per session, or `{ sandbox }` to wrap one the caller owns (it is
 * then never closed by the provider).
 */
export type WasmerSandboxSettings =
  | { readonly sandbox: WasmerSandbox }
  | (Omit<WasmerSandboxOptions, 'signal'> & { readonly sandbox?: never });

export function createWasmerSandbox(settings: WasmerSandboxSettings = {}): WasmerSandboxProvider {
  return new WasmerSandboxProvider(settings);
}

/**
 * `HarnessV1SandboxProvider` backed by local Wasmer sandboxes. For plain AI SDK
 * tools, call `createSession()` and pass `session.restricted()` as
 * `experimental_sandbox`.
 *
 * Wasmer sandboxes run in-process: there is no snapshot or resume, and no
 * exposed ports, so bridge-backed harness adapters (Claude Code, Codex) are
 * rejected when they ask for a port.
 */
export class WasmerSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1';
  readonly providerId = WASMER_SANDBOX_PROVIDER_ID;
  readonly #settings: WasmerSandboxSettings;

  constructor(settings: WasmerSandboxSettings) {
    this.#settings = settings;
  }

  createSession = async (
    options: {
      sessionId?: string;
      abortSignal?: AbortSignal;
      identity?: string;
      onFirstCreate?: (
        session: Experimental_SandboxSession,
        opts: { abortSignal?: AbortSignal },
      ) => Promise<void>;
    } = {},
  ): Promise<WasmerNetworkSandboxSession> => {
    const { abortSignal, onFirstCreate } = options;
    abortSignal?.throwIfAborted();
    const owned = this.#settings.sandbox === undefined;
    const sandbox =
      this.#settings.sandbox ??
      (await WasmerSandbox.create({
        ...(this.#settings as WasmerSandboxOptions),
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      }));
    const session = new WasmerNetworkSandboxSession(sandbox, owned);
    try {
      // No snapshots: every created session is a first creation.
      await onFirstCreate?.(session.restricted(), abortSignal !== undefined ? { abortSignal } : {});
    } catch (error) {
      await session.destroy();
      throw error;
    }
    return session;
  };
}

export class WasmerNetworkSandboxSession
  extends WasmerSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly id = randomUUID();
  readonly defaultWorkingDirectory: string;
  readonly ports: readonly number[] = [];
  readonly #sandbox: WasmerSandbox;
  readonly #owned: boolean;

  constructor(sandbox: WasmerSandbox, owned: boolean) {
    super(sandbox);
    this.#sandbox = sandbox;
    this.#owned = owned;
    this.defaultWorkingDirectory = sandbox.defaultWorkingDirectory;
  }

  /** The wrapped sandbox, for Wasmer-specific capabilities. */
  get sandbox(): WasmerSandbox {
    return this.#sandbox;
  }

  getPortEndpoint = async (_options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<HarnessV1PortEndpoint> => {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: WASMER_SANDBOX_PROVIDER_ID,
      message:
        'Wasmer sandboxes run in-process and do not expose ports yet. Use a hosted sandbox for bridge-backed harness adapters.',
    });
  };

  /** @deprecated Use `getPortEndpoint` instead. */
  getPortUrl = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => (await this.getPortEndpoint(options)).url;

  /** Closes the sandbox if this provider created it. Idempotent. */
  stop = async (): Promise<void> => {
    if (this.#owned) await this.#sandbox.close();
  };

  destroy = async (): Promise<void> => {
    await this.stop();
  };

  restricted = (): Experimental_SandboxSession => new WasmerSandboxSession(this.#sandbox);
}
