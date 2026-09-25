import { type Experimental_SandboxSession, extractLines } from '@ai-sdk/provider-utils';
import {
  type ExecResult,
  type WasmerSandbox,
  WORKSPACE_DIR,
} from '@owenota1337/wasmer-sandbox-core';

type SandboxSession = Experimental_SandboxSession;
type ProcessOptions = Parameters<SandboxSession['run']>[0];
type ReadOptions = Parameters<SandboxSession['readFile']>[0];
type TextReadOptions = Parameters<SandboxSession['readTextFile']>[0];
type WriteOptions<C> = { path: string; content: C; abortSignal?: AbortSignal };

/**
 * The AI SDK `Experimental_SandboxSession` view of a {@link WasmerSandbox}:
 * command execution, streaming processes and file I/O, nothing that can stop
 * the sandbox. Relative paths resolve against `/workspace`.
 */
export class WasmerSandboxSession implements SandboxSession {
  readonly #sandbox: WasmerSandbox;

  constructor(sandbox: WasmerSandbox) {
    this.#sandbox = sandbox;
  }

  get description(): string {
    const { packages, network } = this.#sandbox.provenance;
    return [
      'Local Wasmer sandbox: WebAssembly (WASIX) guests, not a full Linux system.',
      `Installed packages: ${packages.join(', ')}. Only their commands exist; there is no package manager.`,
      `Commands run in bash. Working directory: ${this.#sandbox.defaultWorkingDirectory}. HOME: ${this.#sandbox.home}.`,
      `Only files under ${WORKSPACE_DIR} persist between commands; /tmp and every other path start empty for each command.`,
      network === 'disabled' ? 'Network access is disabled.' : `Network mode: ${network}.`,
    ].join('\n');
  }

  run = async ({ command, workingDirectory, env, abortSignal }: ProcessOptions) => {
    const result = await this.#sandbox.exec(command, {
      ...(workingDirectory !== undefined ? { cwd: workingDirectory } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: withNotes(result) };
  };

  spawn = async ({ command, workingDirectory, env, abortSignal }: ProcessOptions) => {
    const spawned = await this.#sandbox.spawn(command, {
      ...(workingDirectory !== undefined ? { cwd: workingDirectory } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
    });
    return {
      pid: spawned.pid,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      wait: async () => ({ exitCode: (await spawned.wait()).exitCode }),
      kill: () => spawned.kill(),
    };
  };

  readFile = async ({ path, abortSignal }: ReadOptions) => {
    const bytes = await this.readBinaryFile({ path, ...optionalSignal(abortSignal) });
    if (bytes === null) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };

  readBinaryFile = async ({ path, abortSignal }: ReadOptions) => {
    abortSignal?.throwIfAborted();
    return this.#sandbox.readFile(path);
  };

  readTextFile = async ({
    path,
    encoding = 'utf-8',
    startLine,
    endLine,
    abortSignal,
  }: TextReadOptions) => {
    const bytes = await this.readBinaryFile({ path, ...optionalSignal(abortSignal) });
    if (bytes === null) return null;
    const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
    return extractLines({
      text,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    });
  };

  writeFile = async ({ path, content, abortSignal }: WriteOptions<ReadableStream<Uint8Array>>) => {
    const bytes = new Uint8Array(await new Response(content).arrayBuffer());
    await this.writeBinaryFile({ path, content: bytes, ...optionalSignal(abortSignal) });
  };

  writeBinaryFile = async ({ path, content, abortSignal }: WriteOptions<Uint8Array>) => {
    abortSignal?.throwIfAborted();
    await this.#sandbox.writeFile(path, content);
  };

  writeTextFile = async ({
    path,
    content,
    encoding = 'utf-8',
    abortSignal,
  }: WriteOptions<string> & { encoding?: string }) => {
    await this.writeBinaryFile({
      path,
      content: encodeText(content, encoding),
      ...optionalSignal(abortSignal),
    });
  };
}

/**
 * The session contract returns only exit code and streams, so timeouts and
 * truncation would otherwise be invisible to the model. Report them on stderr.
 */
function withNotes(result: ExecResult): string {
  const notes: string[] = [];
  if (result.reason === 'timeout') notes.push('[wasmer-sandbox] command timed out and was killed');
  if (result.reason === 'terminated') notes.push('[wasmer-sandbox] command was terminated');
  if (result.truncated.stdout) notes.push('[wasmer-sandbox] stdout was truncated');
  if (result.truncated.stderr) notes.push('[wasmer-sandbox] stderr was truncated');
  if (notes.length === 0) return result.stderr;
  const separator = result.stderr === '' || result.stderr.endsWith('\n') ? '' : '\n';
  return `${result.stderr}${separator}${notes.join('\n')}\n`;
}

// Buffer, not TextDecoder: TextDecoder drops a UTF-8 BOM, which would change a
// file across a read/write round trip. Unknown encodings throw.
function encodeText(content: string, encoding: string): Uint8Array {
  const buffer = Buffer.from(content, encoding as BufferEncoding);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function optionalSignal(abortSignal: AbortSignal | undefined) {
  return abortSignal !== undefined ? { abortSignal } : {};
}
