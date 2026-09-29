// A live model does a small data task by running Python in a local Wasmer sandbox, through the
// AI SDK provider in packages/ai-sdk. Every command it runs, and what came back, is printed.
//
//   pnpm build && pnpm --filter agent-demo demo
//
// Needs FIREWORKS_API_KEY (or the key alone in ./fireworks.txt at the repo root, which git
// ignores locally). DEMO_MODEL picks another Fireworks model.
import { existsSync, readFileSync } from 'node:fs';
import { createFireworks } from '@ai-sdk/fireworks';
import { createWasmerSandbox } from '@owenota1337/wasmer-sandbox-ai-sdk';
import { generateText, isStepCount, jsonSchema, tool } from 'ai';

const MODEL = process.env.DEMO_MODEL ?? 'accounts/fireworks/models/kimi-k3';
const keyFile = new URL('../../fireworks.txt', import.meta.url);
const apiKey =
  process.env.FIREWORKS_API_KEY ??
  (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined);
if (!apiKey)
  throw new Error('Set FIREWORKS_API_KEY, or put the key in fireworks.txt at the repo root');

const SALES = `month,region,units,price
2026-01,north,120,9.5
2026-01,south,80,11
2026-01,west,95,10
2026-02,north,135,9.5
2026-02,south,70,11
2026-02,west,110,10
2026-03,north,150,9
2026-03,south,65,11.5
2026-03,west,140,10
`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const indent = (s: string) => s.trimEnd().replace(/^/gm, '    ');
const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

const session = await createWasmerSandbox({
  packages: ['python/python@=3.13.20'],
  files: { 'sales.csv': SALES },
}).createSession();
process.once('SIGINT', () => void session.destroy().finally(() => process.exit(130)));

let commands = 0;
const shell = tool({
  description: 'Run a bash command in the sandbox. Python is available as `python`.',
  inputSchema: jsonSchema<{ command: string }>({
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  }),
  execute: async ({ command }, { abortSignal, experimental_sandbox }) => {
    if (!experimental_sandbox) throw new Error('No sandbox');
    commands++;
    console.log(`\n${dim(elapsed())} ${bold('$')} ${clip(command, 400)}`);
    const t = performance.now();
    const result = await experimental_sandbox.run({
      command,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const took = ((performance.now() - t) / 1000).toFixed(1);
    console.log(dim(`    exit ${result.exitCode} in ${took}s, inside Wasmer`));
    if (result.stdout) console.log(indent(clip(result.stdout, 800)));
    if (result.stderr) console.log(dim(indent(clip(result.stderr, 400))));
    return result;
  },
});

console.log(bold('Local Wasmer sandbox + AI SDK'), dim(`model ${MODEL.split('/').pop()}`));
console.log(dim('guest sees only /workspace/sales.csv · network off · no host env\n'));
const task =
  'sales.csv has monthly units and price per region. Using Python, find the region with the most ' +
  "revenue in the latest month and each region's revenue growth from January to March. Write a short " +
  'markdown summary to report.md, then give me the answer in two sentences.';
console.log(`${bold('Task:')} ${task}`);

try {
  const result = await generateText({
    model: createFireworks({ apiKey })(MODEL),
    tools: { shell },
    experimental_sandbox: session.restricted(),
    system: session.description,
    stopWhen: isStepCount(8),
    prompt: task,
  });
  // Read back through the session's file API: the file only exists inside the guest.
  const report = await session.readTextFile({ path: 'report.md' }).catch(() => null);
  console.log(
    dim(
      `\nreport.md in the sandbox: ${report ? `${report.trimEnd().split('\n').length} lines` : 'not written'}`,
    ),
  );
  console.log(`\n${bold('Answer:')} ${result.text.trim()}`);
  const tokens = result.totalUsage.totalTokens ?? 0;
  console.log(
    dim(
      `\n${result.steps.length} model steps · ${commands} sandbox commands · ${tokens} tokens · ${elapsed()}`,
    ),
  );
} finally {
  await session.destroy();
}
