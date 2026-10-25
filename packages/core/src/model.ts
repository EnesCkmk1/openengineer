import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { EngineConfig } from './config.js';
import {
  AiReviewSchema,
  OpenEngineerError,
  type ModelMessage,
  type ToolCall,
} from '@openengineer/shared';

export type { ToolCall };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: ModelUsage;
  tokenAccounting: 'provider' | 'heuristic';
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ModelCompleteInput {
  purpose: 'plan' | 'implement' | 'review';
  repairAttempt: number;
  turnIndex: number;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  complete(input: ModelCompleteInput): Promise<ModelResponse>;
}

const PRICE_PER_MILLION_USD: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
};

export function estimateCostUsd(model: string, usage: ModelUsage): number | null {
  const price = PRICE_PER_MILLION_USD[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export function heuristicTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const ScriptedStepSchema = z.object({
  content: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.unknown() })).optional(),
});

export const ScriptedProgramSchema = z.object({
  plan: z.unknown(),
  clarifyFirst: z.object({ questions: z.array(z.string().min(1)).min(1) }).optional(),
  implement: z.array(ScriptedStepSchema),
  repair: z.array(z.array(ScriptedStepSchema)).optional(),
  review: AiReviewSchema.optional(),
});
export type ScriptedProgram = z.infer<typeof ScriptedProgramSchema>;

export class ScriptedModel implements ModelAdapter {
  readonly provider = 'scripted';
  readonly model = 'scripted-1';

  constructor(private readonly program: ScriptedProgram) {}

  async complete(input: ModelCompleteInput): Promise<ModelResponse> {
    if (input.signal?.aborted) {
      throw new OpenEngineerError('Model call aborted', 'cancelled');
    }
    const promptText = input.messages.map((message) => message.content).join('\n');
    if (input.purpose === 'review') {
      const review = this.program.review ?? {
        summary: 'Scripted review is supplementary accounting data, not evidence of correctness.',
        concerns: [],
        confidence: 'low' as const,
      };
      const content = JSON.stringify(review);
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: heuristicTokens(promptText), outputTokens: heuristicTokens(content) },
        tokenAccounting: 'heuristic',
        finishReason: 'stop',
      };
    }
    if (input.purpose === 'plan') {
      const clarified = input.messages.some(
        (message) => message.role === 'tool' && (message.name === 'request_clarification' || message.name === 'submit_plan'),
      );
      if (this.program.clarifyFirst && !clarified) {
        return this.toolResponse(promptText, [
          { id: 'plan_clarify', name: 'request_clarification', arguments: { questions: this.program.clarifyFirst.questions } },
        ]);
      }
      return this.toolResponse(promptText, [
        { id: 'plan_submit', name: 'submit_plan', arguments: this.program.plan },
      ]);
    }
    const queue = input.repairAttempt > 0 ? (this.program.repair?.[input.repairAttempt - 1] ?? []) : this.program.implement;
    const step = queue[input.turnIndex];
    if (!step) {
      return {
        content: '',
        toolCalls: [],
        usage: { inputTokens: heuristicTokens(promptText), outputTokens: 1 },
        tokenAccounting: 'heuristic',
        finishReason: 'stop',
      };
    }
    const toolCalls = (step.toolCalls ?? []).map((call, callIndex) => ({
      id: `call_${input.repairAttempt}_${input.turnIndex}_${callIndex}`,
      name: call.name,
      arguments: call.arguments,
    }));
    const content = step.content ?? '';
    return {
      content,
      toolCalls,
      usage: { inputTokens: heuristicTokens(promptText), outputTokens: heuristicTokens(content) + toolCalls.length * 8 },
      tokenAccounting: 'heuristic',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  private toolResponse(promptText: string, toolCalls: ToolCall[]): ModelResponse {
    return {
      content: '',
      toolCalls,
      usage: { inputTokens: heuristicTokens(promptText), outputTokens: 40 },
      tokenAccounting: 'heuristic',
      finishReason: 'tool_calls',
    };
  }
}

export function createModel(config: EngineConfig): ModelAdapter {
  if (config.provider === 'anthropic') {
    if (!config.anthropicApiKey) {
      throw new OpenEngineerError('ANTHROPIC_API_KEY is not set', 'model_error');
    }
    return new AnthropicAdapter({ apiKey: config.anthropicApiKey, model: config.anthropicModel });
  }
  if (config.provider === 'scripted') {
    if (!config.scriptedFile) {
      throw new OpenEngineerError(
        'OPENENGINEER_SCRIPTED_FILE is required for the scripted provider. The scripted provider is a deterministic test double, not an intelligent agent.',
        'model_error',
      );
    }
    return new ScriptedModel(loadScriptedProgram(config.scriptedFile));
  }
  if (!config.openaiApiKey) {
    throw new OpenEngineerError('OPENAI_API_KEY is not set', 'model_error');
  }
  return new OpenAiAdapter({
    apiKey: config.openaiApiKey,
    baseUrl: config.openaiBaseUrl,
    model: config.openaiModel,
  });
}

export function loadScriptedProgram(file: string): ScriptedProgram {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OpenEngineerError(`Could not read scripted program ${file}: ${(error as Error).message}`, 'model_error');
  }
  const parsed = ScriptedProgramSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenEngineerError('Scripted program file is invalid', 'validation', parsed.error.flatten());
  }
  return parsed.data;
}

export class OpenAiAdapter implements ModelAdapter {
  readonly provider = 'openai';
  constructor(
    private readonly options: { apiKey: string; baseUrl: string; model: string },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async complete(input: ModelCompleteInput): Promise<ModelResponse> {
    const body = {
      model: this.options.model,
      temperature: 0,
      messages: input.messages.map((message) => {
        if (message.role === 'tool') {
          return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
          return {
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
          };
        }
        return { role: message.role, content: message.content };
      }),
      tools: input.tools?.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    };
    const payload = await postJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body,
      input.signal,
    );
    const choice = asRecord(asRecord(payload).choices && (asRecord(payload).choices as unknown[])[0]);
    const message = asRecord(choice.message);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((entry) => {
          const call = asRecord(entry);
          const fn = asRecord(call.function);
          return {
            id: String(call.id ?? randomId()),
            name: String(fn.name ?? ''),
            arguments: parseUnknownJson(fn.arguments),
          };
        })
      : [];
    const usage = asRecord(asRecord(payload).usage);
    const content = typeof message.content === 'string' ? message.content : '';
    const hasProviderUsage = typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number';
    return {
      content,
      toolCalls,
      usage: hasProviderUsage
        ? { inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number }
        : {
            inputTokens: heuristicTokens(JSON.stringify(input.messages)),
            outputTokens: heuristicTokens(content),
          },
      tokenAccounting: hasProviderUsage ? 'provider' : 'heuristic',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop',
    };
  }
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  constructor(private readonly options: { apiKey: string; model: string }) {}

  get model(): string {
    return this.options.model;
  }

  async complete(input: ModelCompleteInput): Promise<ModelResponse> {
    const system = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages: Array<Record<string, unknown>> = [];
    for (const message of input.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'user') {
        messages.push({ role: 'user', content: message.content });
      } else if (message.role === 'assistant') {
        const content: Array<Record<string, unknown>> = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
        }
        messages.push({ role: 'assistant', content: content.length > 0 ? content : message.content });
      } else if (message.role === 'tool') {
        const block = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        };
        const previous = messages[messages.length - 1];
        if (previous?.role === 'user' && Array.isArray(previous.content)) {
          (previous.content as unknown[]).push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
      }
    }
    const payload = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      {
        model: this.options.model,
        max_tokens: 4096,
        temperature: 0,
        system,
        tools: input.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        messages,
      },
      input.signal,
    );
    const contentBlocks = Array.isArray(asRecord(payload).content) ? (asRecord(payload).content as unknown[]) : [];
    const text = contentBlocks
      .map((block) => asRecord(block))
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n');
    const toolCalls = contentBlocks
      .map((block) => asRecord(block))
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: String(block.id ?? randomId()),
        name: String(block.name ?? ''),
        arguments: block.input ?? {},
      }));
    const usage = asRecord(asRecord(payload).usage);
    const hasProviderUsage = typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number';
    return {
      content: text,
      toolCalls,
      usage: hasProviderUsage
        ? { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number }
        : { inputTokens: heuristicTokens(JSON.stringify(messages)), outputTokens: heuristicTokens(text) },
      tokenAccounting: hasProviderUsage ? 'provider' : 'heuristic',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
  } catch (error) {
    if (signal?.aborted) throw new OpenEngineerError('Model call aborted', 'cancelled');
    throw new OpenEngineerError(`Model request failed: ${(error as Error).message}`, 'model_error');
  }
  const text = await response.text();
  if (!response.ok) {
    throw new OpenEngineerError(`Model provider returned HTTP ${response.status}: ${text.slice(0, 500)}`, 'model_error');
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new OpenEngineerError('Model provider returned invalid JSON', 'model_error');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseUnknownJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function randomId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}
