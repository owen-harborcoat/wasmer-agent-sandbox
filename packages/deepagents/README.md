# @owenota1337/wasmer-sandbox-deepagents

Local [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) sandboxes as a
[Deep Agents](https://github.com/langchain-ai/deepagentsjs) sandbox backend. It passes
`@langchain/sandbox-standard-tests` (93 of 93), the suite LangChain's own sandbox packages run.

The agent's shell commands and file tools work on a WebAssembly (WASIX) sandbox inside your Node
process. There's no container, VM or remote service, and networking is off unless you enable it.

Community package, not affiliated with or endorsed by Wasmer or LangChain.

## Use

```ts
import { createDeepAgent } from 'deepagents';
import { WasmerDeepAgentsSandbox } from '@owenota1337/wasmer-sandbox-deepagents';

const backend = await WasmerDeepAgentsSandbox.create({
  packages: ['python/python@=3.13.20'],
  initialFiles: { '/workspace/data.csv': 'a,b\n1,2\n' },
});
try {
  const agent = createDeepAgent({ model: 'anthropic:claude-sonnet-5-5', backend });
  const result = await agent.invoke({
    messages: [{ role: 'user', content: 'Sum column b of /workspace/data.csv with Python.' }],
  });
  console.log(result.messages.at(-1)?.content);
} finally {
  await backend.close();
}
```

`test/agent.wasmer.test.ts` runs the same loop with a scripted model (no API key).

## Options

Everything `WasmerSandbox` in `@owenota1337/wasmer-sandbox-core` takes, with files named the
Deep Agents way:

| Option | Default | |
|---|---|---|
| `initialFiles` | none | Path → contents, under `/workspace` (absolute or relative). Anything outside is rejected. |
| `packages` | none | Extra registry packages, e.g. `python/python@=3.13.20`, or `NODE_PACKAGE` from core. The shell is `wasmer/bash@=1.0.25`. |
| `env` | `HOME=/workspace/.home` | The host environment is never inherited. |
| `network` | `{ mode: 'disabled' }` | `{ mode: 'host' }` gives the guest host networking. |
| `limits` | 60 s, 1 MiB | Per-command `timeoutMs`, and `outputBytes` kept per stream. |
| `wasmer` | new client | Share a `Wasmer` client between sandboxes. |

`new WasmerDeepAgentsSandbox(options)` plus `initialize()` is the two-step form. `close()` is idempotent.

## Behaviour to know about

- **`ls`, `read`, `grep` and `glob` run on the host**, through the SDK's filesystem API. Deep Agents'
  `BaseSandbox` builds them from `find`, `stat` and `awk`, which the guest's shell package doesn't have.
  Results match `BaseSandbox`'s formats, except that there's no `modified_at`: the SDK doesn't report
  modification times. `execute`, `write`, `edit` and `delete` work as in `BaseSandbox`.
- **Only `/workspace` persists between commands**, so that's where files live. Uploads and downloads
  elsewhere return `invalid_path`. A search rooted at `/` covers `/workspace`, and `ls('/')` shows it.
- **`execute` output is stdout then stderr.** Timeouts and truncation are noted at the end
  (`[wasmer-sandbox] ...`).
- **A command that never blocks can't be stopped** by the timeout
  ([wasmerio/wasmer-sdk#556](https://github.com/wasmerio/wasmer-sdk/issues/556)). It's reported as
  timed out but keeps a core until your process exits.
- The command's own stdio reports as a terminal
  ([wasmerio/wasmer-sdk#555](https://github.com/wasmerio/wasmer-sdk/issues/555)), so programs may print
  prompts or colour codes.
