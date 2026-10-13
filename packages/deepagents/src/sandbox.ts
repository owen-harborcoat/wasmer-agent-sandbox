import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  type DirectoryEntry,
  SandboxPathError,
  stderrWithNotes,
  WasmerSandbox,
  type WasmerSandboxOptions,
  WORKSPACE_DIR,
} from '@owenota1337/wasmer-sandbox-core';
import {
  applyGrepMaxCount,
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileInfo,
  type FileOperationError,
  type FileUploadResponse,
  type GlobResult,
  type GrepMatch,
  type GrepResult,
  type LsResult,
  normalizeReadPagination,
  type ReadResult,
} from 'deepagents';

/**
 * Options for {@link WasmerDeepAgentsSandbox}: everything a core `WasmerSandbox`
 * takes, with files named the deepagents way.
 */
export type WasmerDeepAgentsSandboxOptions = Omit<WasmerSandboxOptions, 'files' | 'signal'> & {
  /** Guest path (absolute under `/workspace`, or relative to it) → contents. */
  readonly initialFiles?: Readonly<Record<string, string | Uint8Array>>;
};

/** Same cap as deepagents' own `glob`, so a walk of a huge tree stays bounded. */
const MAX_WALK_ENTRIES = 50_000;

/**
 * A deepagents sandbox backend running on a local Wasmer sandbox.
 *
 * `execute` runs bash in the guest. The file tools that `BaseSandbox` builds from
 * `find`, `stat` and `awk` (`ls`, `read`, `grep`, `glob`) run on the host through
 * the SDK's filesystem API instead: the guest's shell package doesn't ship those
 * tools. Only `/workspace` persists between commands, so that's where files live;
 * a search rooted at `/` covers `/workspace`.
 */
export class WasmerDeepAgentsSandbox extends BaseSandbox {
  readonly id = `wasmer-${randomUUID()}`;
  readonly #options: WasmerDeepAgentsSandboxOptions;
  #sandbox: WasmerSandbox | undefined;
  #closed = false;

  constructor(options: WasmerDeepAgentsSandboxOptions = {}) {
    super();
    this.#options = options;
  }

  static async create(
    options: WasmerDeepAgentsSandboxOptions = {},
  ): Promise<WasmerDeepAgentsSandbox> {
    const sandbox = new WasmerDeepAgentsSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  get isRunning(): boolean {
    return this.#sandbox !== undefined && !this.#closed;
  }

  /** The core sandbox underneath, once initialized. */
  get sandbox(): WasmerSandbox {
    if (this.#sandbox === undefined || this.#closed) {
      throw new Error(this.#closed ? 'Sandbox is closed' : 'Sandbox is not initialized');
    }
    return this.#sandbox;
  }

  async initialize(): Promise<void> {
    if (this.#sandbox !== undefined) return;
    if (this.#closed) throw new Error('Sandbox is closed');
    const { initialFiles, ...options } = this.#options;
    const files: Record<string, string | Uint8Array> = {};
    for (const [path, contents] of Object.entries(initialFiles ?? {})) {
      files[workspacePath(path)] = contents;
    }
    this.#sandbox = await WasmerSandbox.create({ ...options, files });
  }

  /** Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sandbox?.close();
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const result = await this.sandbox.exec(command);
    return {
      output: result.stdout + stderrWithNotes(result),
      exitCode: result.exitCode,
      truncated: result.truncated.stdout || result.truncated.stderr,
    };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      results.push({ path, error: await this.#upload(path, content) });
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const path of paths) {
      const outcome = await this.#download(path);
      results.push(
        outcome instanceof Uint8Array
          ? { path, content: outcome, error: null }
          : { path, content: null, error: outcome },
      );
    }
    return results;
  }

  override async ls(path: string): Promise<LsResult> {
    const dir = guestPath(path);
    if (!isInWorkspace(dir)) {
      return { files: dir === '/' ? [{ path: `${WORKSPACE_DIR}/`, is_dir: true }] : [] };
    }
    const entries = await this.sandbox.readDir(dir);
    return { files: (entries ?? []).map((entry) => fileInfo(posix.join(dir, entry.name), entry)) };
  }

  override async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    if (!isTextPath(filePath)) return super.read(filePath, offset, limit);
    const mimeType = 'text/plain';
    const pagination = normalizeReadPagination(offset, limit);
    if (pagination.limit === 0) return { content: '', mimeType };
    const [download] = await this.downloadFiles([filePath]);
    if (download?.content == null) return { error: `File '${filePath}' not found` };
    const text = new TextDecoder().decode(download.content);
    if (text === '')
      return { content: 'System reminder: File exists but has empty contents\n', mimeType };
    return { ...numberedSlice(text, pagination.offset, pagination.limit), mimeType };
  }

  override async grep(
    pattern: string,
    path = '/',
    glob: string | null = null,
    maxCount: number | null = null,
  ): Promise<GrepResult> {
    const nameFilter = glob ? globToRegex(glob) : null;
    const matches: GrepMatch[] = [];
    for (const file of await this.#walk(guestPath(path))) {
      if (file.is_dir || !isTextPath(file.path)) continue;
      if (nameFilter && !nameFilter.test(posix.basename(file.path))) continue;
      const bytes = await this.sandbox.readFile(file.path);
      if (bytes === null) continue;
      const lines = new TextDecoder().decode(bytes).split('\n');
      lines.forEach((text, index) => {
        if (text.includes(pattern)) matches.push({ path: file.path, line: index + 1, text });
      });
    }
    return applyGrepMaxCount({ result: { matches }, maxCount });
  }

  override async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const base = guestPath(path);
    const regex = globToRegex(pattern);
    const all = await this.#walk(base, true);
    const files: FileInfo[] = [];
    for (const info of all) {
      const relative = posix.relative(base, info.path);
      if (regex.test(relative)) files.push({ ...info, path: relative });
    }
    return { files, truncated: all.length >= MAX_WALK_ENTRIES };
  }

  async #upload(path: string, content: Uint8Array): Promise<FileOperationError | null> {
    let resolved: string;
    try {
      resolved = workspacePath(path);
    } catch {
      return 'invalid_path';
    }
    if ((await this.sandbox.stat(resolved))?.kind === 'directory') return 'is_directory';
    try {
      await this.sandbox.writeFile(resolved, content);
      return null;
    } catch (error) {
      // A path through an existing file: `mkdir` reports "fd not a directory".
      if (error instanceof Error && /not a directory/i.test(error.message)) return 'invalid_path';
      throw error;
    }
  }

  async #download(path: string): Promise<Uint8Array | FileOperationError> {
    let resolved: string;
    try {
      resolved = workspacePath(path);
    } catch {
      return 'invalid_path';
    }
    const stat = await this.sandbox.stat(resolved);
    if (stat === null) return 'file_not_found';
    if (stat.kind === 'directory') return 'is_directory';
    return (await this.sandbox.readFile(resolved)) ?? 'file_not_found';
  }

  /**
   * Everything under `root` (a file root yields itself), depth first, sorted by
   * name. Roots above `/workspace` search `/workspace`; other roots outside it
   * have nothing that persists, and yield nothing.
   */
  async #walk(root: string, includeDirs = false): Promise<FileInfo[]> {
    const start = isInWorkspace(root) ? root : root === '/' ? WORKSPACE_DIR : null;
    if (start === null) return [];
    const stat = await this.sandbox.stat(start);
    if (stat === null) return [];
    if (stat.kind === 'file') return [fileInfo(start, stat)];
    const found: FileInfo[] = [];
    if (start !== root && includeDirs) found.push(fileInfo(start, stat));
    const visit = async (dir: string): Promise<void> => {
      const entries = [...((await this.sandbox.readDir(dir)) ?? [])].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const entry of entries) {
        if (found.length >= MAX_WALK_ENTRIES) return;
        const child = posix.join(dir, entry.name);
        if (entry.kind === 'directory') {
          if (includeDirs) found.push(fileInfo(child, entry));
          await visit(child);
        } else {
          found.push(fileInfo(child, entry));
        }
      }
    };
    await visit(start);
    return found;
  }
}

/** Absolute and normalized: `//a///b/` → `/a/b`. Relative paths resolve against `/workspace`. */
function guestPath(path: string): string {
  return posix.resolve(WORKSPACE_DIR, path);
}

function workspacePath(path: string): string {
  const resolved = guestPath(path);
  if (!isInWorkspace(resolved)) throw new SandboxPathError(resolved);
  return resolved;
}

function isInWorkspace(path: string): boolean {
  return path === WORKSPACE_DIR || path.startsWith(`${WORKSPACE_DIR}/`);
}

/** deepagents' `ls` format: absolute paths, directories with a trailing slash. */
function fileInfo(path: string, entry: Pick<DirectoryEntry, 'kind' | 'size'>): FileInfo {
  const isDir = entry.kind === 'directory';
  return { path: isDir ? `${path}/` : path, is_dir: isDir, size: entry.size };
}

/**
 * `read`'s text format, as `BaseSandbox` produces it with awk: `%6d\t%s` rows for the
 * requested window, plus pagination fields when the window is inside the file.
 */
function numberedSlice(text: string, offset: number, limit: number): ReadResult {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const totalLines = lines.length;
  const window = lines.slice(offset, offset + limit);
  const content = window
    .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}\n`)
    .join('');
  const end = Math.min(offset + limit, totalLines);
  if (offset >= totalLines || end <= offset) return { content };
  return {
    content,
    totalLines,
    startLine: offset + 1,
    endLine: end,
    ...(end < totalLines ? { nextOffset: end } : {}),
  };
}

// deepagents treats only these as binary; everything else, including unknown extensions, is text.
const BINARY_EXTENSIONS = new Set(
  (
    '.png .jpg .jpeg .gif .webp .heic .heif .mp3 .wav .aiff .aac .ogg .flac .mp4 .webm .mpeg ' +
    '.mov .avi .flv .mpg .wmv .3gpp .pdf .ppt .pptx'
  ).split(' '),
);

function isTextPath(path: string): boolean {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 || !BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** deepagents' glob syntax: `*` and `?` stop at `/`, `**` crosses it, `[...]` classes. */
function globToRegex(pattern: string): RegExp {
  let regex = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      i += 2;
      if (pattern[i] === '/') {
        regex += '(.*/)?';
        i++;
      } else {
        regex += '.*';
      }
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      const end = close === -1 ? pattern.length : close + 1;
      regex += pattern.slice(i, end);
      i = end;
    } else {
      regex += /[.+^${}()|\\]/.test(c) ? `\\${c}` : c;
      i++;
    }
  }
  return new RegExp(`${regex}$`);
}
