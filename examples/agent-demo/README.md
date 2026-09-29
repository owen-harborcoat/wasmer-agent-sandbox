# agent-demo

A live model does a small data task by writing and running Python in a local Wasmer sandbox, through
[`packages/ai-sdk`](../../packages/ai-sdk). Every command and its output is printed. The guest sees only
`sales.csv`, with the network off and no host environment.

Needs Node 24 (the repo's `.node-version`) or 22.19+. With fnm: `fnm exec --using=24 pnpm ...`.

```bash
pnpm install && pnpm build
FIREWORKS_API_KEY=... pnpm --filter agent-demo demo
```

It uses [Fireworks](https://fireworks.ai) through `@ai-sdk/fireworks`. The default model is Kimi K3
(~30 s, right in 4 of 4 runs on 2026-09-28). `DEMO_MODEL=accounts/fireworks/models/deepseek-v4p1-flash`
takes ~8 s, but its final answer tends to be terse. Any AI SDK provider works with a one-line change.

[`sample-run.txt`](sample-run.txt) is one full run.
