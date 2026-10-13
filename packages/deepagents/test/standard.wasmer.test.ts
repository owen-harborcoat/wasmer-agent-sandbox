import { sandboxStandardTests } from '@langchain/sandbox-standard-tests/vitest';
import { Wasmer } from '@wasmer/sdk/node';
import { afterAll } from 'vitest';
import { WasmerDeepAgentsSandbox } from '../src/index.js';

// LangChain's provider conformance suite, as every deepagents sandbox package runs it.
const wasmer = new Wasmer();
afterAll(() => wasmer.close());

sandboxStandardTests({
  name: 'WasmerDeepAgentsSandbox',
  sequential: true,
  timeout: 60_000,
  createSandbox: (options) => WasmerDeepAgentsSandbox.create({ wasmer, ...options }),
  createUninitializedSandbox: () => new WasmerDeepAgentsSandbox({ wasmer }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => `/workspace/${name}`,
});
