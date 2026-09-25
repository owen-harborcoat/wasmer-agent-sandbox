import { generateText, isStepCount, jsonSchema, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createWasmerSandbox } from '../src/index.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// A scripted model drives the real AI SDK tool loop, so this runs without API
// keys: the model asks for a shell command, the tool executes it through
// `experimental_sandbox`, and the result is fed back as the next prompt.
describe('generateText with a Wasmer experimental_sandbox', () => {
  it('runs model-requested shell commands inside the sandbox', async () => {
    const session = await createWasmerSandbox().createSession();
    try {
      const model = new MockLanguageModelV4({
        doGenerate: [
          {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'shell',
                input: JSON.stringify({
                  command: 'echo "written by the model" > result.txt && ls && pwd',
                }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          },
          {
            content: [{ type: 'text', text: 'Done.' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          },
        ],
      });

      const shell = tool({
        description: 'Run a bash command in the sandbox.',
        inputSchema: jsonSchema<{ command: string }>({
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        }),
        execute: async ({ command }, { abortSignal, experimental_sandbox }) => {
          if (!experimental_sandbox) throw new Error('Experimental sandbox is not available');
          return experimental_sandbox.run({
            command,
            ...(abortSignal !== undefined ? { abortSignal } : {}),
          });
        },
      });

      const result = await generateText({
        model,
        tools: { shell },
        experimental_sandbox: session.restricted(),
        stopWhen: isStepCount(2),
        prompt: 'Write a file and tell me where you are.',
      });

      expect(result.text).toBe('Done.');
      const [toolResult] = result.steps[0]?.toolResults ?? [];
      expect(toolResult?.output).toEqual({
        exitCode: 0,
        stdout: 'result.txt\n/workspace\n',
        stderr: '',
      });
      // The side effect happened in the guest filesystem, not on the host.
      expect(await session.readTextFile({ path: 'result.txt' })).toBe('written by the model\n');
      // The tool output was sent back to the model on the second call.
      expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('/workspace');
    } finally {
      await session.destroy();
    }
  });
});
