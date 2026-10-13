import { Wasmer } from '@wasmer/sdk/node';
import { createDeepAgent } from 'deepagents';
import { FakeToolCallingModel, type ToolMessage } from 'langchain';
import { afterAll, describe, expect, it } from 'vitest';
import { WasmerDeepAgentsSandbox } from '../src/index.js';

// A real createDeepAgent loop with a scripted model (no API key): its tool calls run against the
// Wasmer backend, and the tool results come back into the conversation.
describe('createDeepAgent on WasmerDeepAgentsSandbox', () => {
  const wasmer = new Wasmer();
  afterAll(() => wasmer.close());

  it('runs execute, grep, write_file and read_file in the sandbox', async () => {
    const backend = await WasmerDeepAgentsSandbox.create({
      wasmer,
      initialFiles: { 'data/prices.csv': 'item,price\napple,3\npear,4\n' },
    });
    try {
      const model = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'execute',
              args: { command: 'cut -d, -f2 /workspace/data/prices.csv | tail -n 2' },
              id: 'c1',
            },
          ],
          [{ name: 'grep', args: { pattern: 'pear', path: '/workspace' }, id: 'c2' }],
          [
            {
              name: 'write_file',
              args: { file_path: '/workspace/total.txt', content: 'total 7\n' },
              id: 'c3',
            },
          ],
          [{ name: 'read_file', args: { file_path: '/workspace/total.txt' }, id: 'c4' }],
          [],
        ],
      });
      const agent = createDeepAgent({ model, backend });

      const result = await agent.invoke({
        messages: [{ role: 'user', content: 'Total the prices.' }],
      });
      const toolOutput = (id: string) => {
        const message = result.messages.find(
          (m): m is ToolMessage => m.type === 'tool' && (m as ToolMessage).tool_call_id === id,
        );
        const content = message?.content;
        // read_file answers with content blocks, the other tools with a string.
        return typeof content === 'string'
          ? content
          : (content ?? []).map((block) => ('text' in block ? block.text : '')).join('');
      };

      expect(toolOutput('c1')).toContain('3\n4');
      expect(toolOutput('c2')).toContain('/workspace/data/prices.csv');
      expect(toolOutput('c4')).toContain('total 7');
      // The file really is in the guest.
      expect((await backend.execute('cat /workspace/total.txt')).output).toBe('total 7\n');
    } finally {
      await backend.close();
    }
  });
});
