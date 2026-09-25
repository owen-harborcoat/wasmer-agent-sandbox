# @owenota1337/wasmer-sandbox-ai-sdk

Local [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) sandboxes for the
[Vercel AI SDK](https://ai-sdk.dev): a `HarnessV1SandboxProvider` whose sessions implement
`Experimental_SandboxSession` (commands, streaming processes and file I/O).

Tool commands run in a WebAssembly (WASIX) sandbox inside your Node process. There's no container,
VM or remote service, and networking is off unless you enable it.

Community package, not affiliated with or endorsed by Wasmer. Experimental: the AI SDK sandbox API
it implements can change in patch releases.

## Use with AI SDK tools

```ts
import { generateText, isStepCount, jsonSchema, tool } from 'ai';
import { createWasmerSandbox } from '@owenota1337/wasmer-sandbox-ai-sdk';

const session = await createWasmerSandbox({
  packages: ['python/python@=3.13.20'],
  files: { 'data.csv': 'a,b\n1,2\n' },
}).createSession();

const shell = tool({
  description: 'Run a bash command in the sandbox.',
  inputSchema: jsonSchema<{ command: string }>({
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  }),
  execute: ({ command }, { abortSignal, experimental_sandbox }) => {
    if (!experimental_sandbox) throw new Error('No sandbox');
    return experimental_sandbox.run({ command, ...(abortSignal ? { abortSignal } : {}) });
  },
});

try {
  const result = await generateText({
    model: 'anthropic/claude-sonnet-5',
    tools: { shell },
    experimental_sandbox: session.restricted(),
    system: session.description,
    stopWhen: isStepCount(10),
    prompt: 'Sum column b of data.csv with Python.',
  });
  console.log(result.text);
} finally {
  await session.destroy();
}
```

The model string goes through the AI Gateway; use any AI SDK model. This snippet has not been run
against a live model. The same loop runs in `test/generate-text.wasmer.test.ts` with a scripted
mock model, so it needs no API key.

`session.description` tells the model what it's working with: installed packages, working
directory, what persists, and network access.

## Options

`createWasmerSandbox(settings)` creates one fresh sandbox per `createSession()`:

| Setting | Default | |
|---|---|---|
| `packages` | none | Extra registry packages, e.g. `python/python@=3.13.20`. The shell comes from `wasmer/bash@=1.0.25`. |
| `files` | none | Written under `/workspace`: the only host data the guest can see. |
| `env` | `HOME=/workspace/.home` | Guest environment. The host environment is never inherited. |
| `network` | `{ mode: 'disabled' }` | `{ mode: 'host' }` gives the guest host networking. |
| `limits` | 60 s, 1 MiB | Per-command `timeoutMs`, and `outputBytes` kept per stream. |
| `wasmer` | new client | Share a `Wasmer` client (package cache, workers) between sessions. |

Pass `{ sandbox }` instead to wrap a `WasmerSandbox` you manage. The provider then never closes it.

## Behaviour to know about

- **Only `/workspace` persists between commands.** `/tmp` and every other path start empty for each
  command. File methods reject other paths with `SandboxPathError` rather than pretending otherwise.
- **Timeouts and truncation** are reported on stderr (`[wasmer-sandbox] ...`), because the session
  contract returns only exit code, stdout and stderr.
- **No ports, snapshots or resume.** Bridge-backed harness adapters that need an exposed port
  (Claude Code, Codex) get `HarnessCapabilityUnsupportedError`. `setNetworkPolicy` is not
  implemented: the network mode is fixed when the sandbox is created.
- **Only the installed packages' commands exist.** `wasmer/bash` brings bash and a coreutils set
  (no `uname`, `which`, `git` or package manager).
