# wasmer-agent-sandbox

Local [Wasmer SDK](https://github.com/wasmerio/wasmer-sdk) sandboxes as an execution backend for agent
frameworks, plus a conformance lab that records where the alpha SDK works and where it breaks.

Community project, not affiliated with or endorsed by Wasmer.

Status: M1 in progress. See [PLAN.md](PLAN.md).

## Development

Requires Node 24 (or 22.23+) and pnpm 10.

```bash
pnpm install
pnpm check         # lint, typecheck, unit tests
pnpm test:wasmer   # real Wasmer sandboxes; first run downloads packages into ./.wasmer
```
