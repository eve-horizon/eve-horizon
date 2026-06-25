import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveCliAdapter } from './harnesses/index';
import type { HarnessName, PermissionPolicy } from './harnesses/types';

type Options = {
  harness?: string;
  variant?: string;
  permission: PermissionPolicy;
  prompt?: string;
  workspace?: string;
  outputFormat: string;
  model?: string;
  reasoning?: string;
};

type NormalizedEvent = {
  seq: number;
  ts: string;
  kind: 'assistant' | 'tool_use' | 'tool_result' | 'hitl' | 'system' | 'error';
  tool?: string;
  hitl?: 'permission' | 'question' | 'plan_approval';
  error?: string;
  raw: Record<string, unknown>;
};

type LlmCallEvent = {
  type: 'llm.call';
  ts: string;
  provider: string;
  model: string;
  source: 'byok' | 'managed';
  status: 'ok' | 'error';
  latency_ms: number | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  };
  meta: {
    correlation_id?: string;
    attempt_id?: string;
    job_id?: string;
  };
};

const DEFAULT_OUTPUT_FORMAT = 'stream-json';

function printUsage(): void {
  const text = `Usage: eve-agent-cli --harness <name> [options] <prompt>

Options:
  --harness <name>         Harness to run (mclaude, zai, gemini, codex, code, coder)
  --variant <name>         Adapter-defined preset
  --permission <policy>    default | auto_edit | never | yolo (default: default)
  --prompt <text>          Prompt text (otherwise use positional or stdin)
  --workspace <path>       Working directory for harness execution
  --output-format <fmt>    Ignored by proxy; always emits JSONL (default: stream-json)
  --model <name>           Optional model override passed to harness
  --reasoning <level>      Optional reasoning level passed to harness
  -h, --help               Show help
`;
  process.stdout.write(text);
}

function parseArgs(argv: string[]): { options: Options; positional: string[] } {
  const options: Options = {
    permission: 'default',
    outputFormat: DEFAULT_OUTPUT_FORMAT,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--harness') {
      options.harness = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--variant') {
      options.variant = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--permission') {
      options.permission = (argv[i + 1] as PermissionPolicy) || 'default';
      i += 1;
      continue;
    }
    if (arg === '--prompt') {
      options.prompt = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--workspace') {
      options.workspace = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--output-format') {
      options.outputFormat = argv[i + 1] || DEFAULT_OUTPUT_FORMAT;
      i += 1;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--reasoning') {
      options.reasoning = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    positional.push(arg);
  }

  return { options, positional };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function normalizePermission(policy: PermissionPolicy): PermissionPolicy {
  if (policy === 'default' || policy === 'auto_edit' || policy === 'never' || policy === 'yolo') {
    return policy;
  }
  return 'default';
}

function clampNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function inferProvider(harness: HarnessName, env: Record<string, string | undefined>): string {
  const override = env.EVE_LLM_PROVIDER;
  if (override) return override;

  switch (harness) {
    case 'mclaude':
    case 'claude':
      return 'anthropic';
    case 'zai':
      return 'zai';
    case 'gemini':
      return 'google';
    case 'code':
    case 'coder':
    case 'codex':
      return 'openai';
    default:
      return 'unknown';
  }
}

function extractPiProvider(model: string, env: Record<string, string | undefined>): string {
  const override = env.EVE_LLM_PROVIDER;
  if (override) return override;
  if (model.includes('/')) {
    return model.split('/')[0];
  }
  return 'unknown';
}

function inferSource(env: Record<string, string | undefined>, raw?: Record<string, unknown>): 'byok' | 'managed' {
  const rawSource = typeof raw?.source === 'string' ? raw.source : undefined;
  if (rawSource === 'managed') return 'managed';
  const envSource = env.EVE_LLM_SOURCE;
  return envSource === 'managed' ? 'managed' : 'byok';
}

function inferModel(env: Record<string, string | undefined>, opts: { model?: string }, raw?: Record<string, unknown>): string {
  const rawModel = typeof raw?.model === 'string' ? raw.model : undefined;
  if (rawModel) return rawModel;
  if (opts.model) return opts.model;
  return env.CLAUDE_MODEL ?? env.OPENAI_MODEL ?? env.GEMINI_MODEL ?? 'unknown';
}

function extractUsage(raw: Record<string, unknown>): LlmCallEvent['usage'] | null {
  // Common locations
  const message = raw.message as Record<string, unknown> | undefined;
  const msg = raw.msg as Record<string, unknown> | undefined;
  const usage =
    (message?.usage as Record<string, unknown> | undefined)
    ?? (msg?.usage as Record<string, unknown> | undefined)
    ?? (raw.usage as Record<string, unknown> | undefined);
  if (!usage) return null;

  // Normalize provider-specific fields.
  const input =
    (typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined)
    ?? (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined)
    ?? (typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined)
    ?? (typeof usage.input === 'number' ? usage.input : undefined)
    ?? 0;

  const output =
    (typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined)
    ?? (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined)
    ?? (typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined)
    ?? (typeof usage.output === 'number' ? usage.output : undefined)
    ?? 0;

  const cacheRead =
    (typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined)
    ?? (typeof (usage as any).cache_read_input_tokens === 'number' ? (usage as any).cache_read_input_tokens : undefined)
    ?? (typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined)
    ?? 0;

  const cacheWrite =
    (typeof usage.cache_write_tokens === 'number' ? usage.cache_write_tokens : undefined)
    ?? (typeof (usage as any).cache_creation_input_tokens === 'number' ? (usage as any).cache_creation_input_tokens : undefined)
    ?? (typeof usage.cacheWrite === 'number' ? usage.cacheWrite : undefined)
    ?? 0;

  const reasoning =
    (typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens : undefined)
    ?? 0;

  // Only emit when we have some signal of actual token usage.
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  if (input === 0 && output === 0) return null;

  return {
    input_tokens: clampNonNegativeInt(input),
    output_tokens: clampNonNegativeInt(output),
    cache_read_tokens: clampNonNegativeInt(cacheRead),
    cache_write_tokens: clampNonNegativeInt(cacheWrite),
    reasoning_tokens: clampNonNegativeInt(reasoning),
  };
}

function maybeBuildLlmCallEvent(
  raw: Record<string, unknown>,
  ctx: {
    harness: HarnessName;
    model?: string;
    env: Record<string, string | undefined>;
  },
): LlmCallEvent | null {
  // Pass-through: if the harness already emits llm.call, preserve it.
  if (raw.type === 'llm.call') {
    const usage = (raw.usage as Record<string, unknown> | undefined) ?? {};
    return {
      type: 'llm.call',
      ts: typeof raw.ts === 'string' ? raw.ts : new Date().toISOString(),
      provider: typeof raw.provider === 'string' ? raw.provider : inferProvider(ctx.harness, ctx.env),
      model: typeof raw.model === 'string' ? raw.model : inferModel(ctx.env, { model: ctx.model }, raw),
      source: inferSource(ctx.env, raw),
      status: raw.status === 'error' ? 'error' : 'ok',
      latency_ms: typeof raw.latency_ms === 'number' ? raw.latency_ms : null,
      usage: {
        input_tokens: clampNonNegativeInt(usage.input_tokens ?? 0),
        output_tokens: clampNonNegativeInt(usage.output_tokens ?? 0),
        cache_read_tokens: clampNonNegativeInt(usage.cache_read_tokens ?? 0),
        cache_write_tokens: clampNonNegativeInt(usage.cache_write_tokens ?? 0),
        reasoning_tokens: clampNonNegativeInt(usage.reasoning_tokens ?? 0),
      },
      meta: {
        attempt_id: ctx.env.EVE_ATTEMPT_ID,
        job_id: ctx.env.EVE_JOB_ID,
      },
    };
  }

  // pi emits cumulative usage in every message_update; only extract from message_end
  // to avoid duplicate llm.call events per turn.
  if (ctx.harness === 'pi' && raw.type !== 'message_end') return null;

  const usage = extractUsage(raw);
  if (!usage) return null;

  const model = inferModel(ctx.env, { model: ctx.model }, raw);
  let provider: string;
  if (ctx.harness === 'pi') {
    provider = extractPiProvider(model, ctx.env);
  } else {
    provider = inferProvider(ctx.harness, ctx.env);
  }
  const source = inferSource(ctx.env, raw);

  return {
    type: 'llm.call',
    ts: new Date().toISOString(),
    provider,
    model,
    source,
    status: 'ok',
    latency_ms: null,
    usage,
    meta: {
      attempt_id: ctx.env.EVE_ATTEMPT_ID,
      job_id: ctx.env.EVE_JOB_ID,
    },
  };
}


function extractToolName(raw: Record<string, unknown>): string | undefined {
  const message = raw.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? raw.content) as unknown;
  if (Array.isArray(content)) {
    for (const block of content) {
      const obj = block as Record<string, unknown>;
      if (obj && obj.type === 'tool_use' && typeof obj.name === 'string') {
        return obj.name;
      }
    }
  }
  const msg = raw.msg as Record<string, unknown> | undefined;
  const tool = msg?.tool as string | undefined;
  if (tool) return tool;
  // pi emits toolName at top level for tool_execution_start/end
  if (typeof raw.toolName === 'string') return raw.toolName;
  return undefined;
}

function classifyKind(raw: Record<string, unknown>, tool?: string): NormalizedEvent['kind'] {
  if (raw.type === 'tool_result') return 'tool_result';
  if (raw.type === 'assistant') return tool ? 'tool_use' : 'assistant';
  if (raw.type === 'message') {
    const role = raw.role;
    if (role === 'assistant') return tool ? 'tool_use' : 'assistant';
    return 'system';
  }
  const msg = raw.msg as Record<string, unknown> | undefined;
  if (msg?.type === 'agent_message') return 'assistant';
  if (msg?.type === 'task_started') return 'system';
  if (msg?.type === 'agent_reasoning') return 'system';
  if (msg?.type === 'token_count') return 'system';
  // Codex emits item.completed with item.type === 'agent_message'
  const item = raw.item as Record<string, unknown> | undefined;
  if (raw.type === 'item.completed' && item?.type === 'agent_message') return 'assistant';

  // pi events
  if (raw.type === 'message_update') {
    const ame = raw.assistantMessageEvent as Record<string, unknown> | undefined;
    if (ame?.type === 'thinking_delta') return 'system';
    return 'assistant';
  }
  if (raw.type === 'tool_execution_start') return 'tool_use';
  if (raw.type === 'tool_execution_end') return 'tool_result';
  if (raw.type === 'session' || raw.type === 'agent_start' || raw.type === 'agent_end'
      || raw.type === 'turn_start' || raw.type === 'turn_end'
      || raw.type === 'message_start' || raw.type === 'message_end') return 'system';

  return 'system';
}

function classifyHitl(tool?: string): NormalizedEvent['hitl'] | undefined {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan_approval';
  return undefined;
}

function buildEvent(
  seq: number,
  raw: Record<string, unknown>,
): NormalizedEvent {
  const ts = new Date().toISOString();
  const tool = extractToolName(raw);
  const hitl = classifyHitl(tool);
  let kind = classifyKind(raw, tool);
  if (hitl) {
    kind = 'hitl';
  }
  const error = typeof raw.error === 'string' ? raw.error : undefined;
  return {
    seq,
    ts,
    kind,
    tool,
    hitl,
    error,
    raw,
  };
}

function emitEvent(event: NormalizedEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitRawEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  const { options, positional } = parseArgs(process.argv.slice(2));
  if (!options.harness) {
    printUsage();
    process.exit(1);
  }

  const harness = options.harness as HarnessName;
  const adapter = resolveCliAdapter(harness);
  if (!adapter) {
    throw new Error(`Unknown harness: ${options.harness}`);
  }

  let prompt = options.prompt;
  if (!prompt && positional.length > 0) {
    prompt = positional.join(' ');
  }
  if (!prompt) {
    prompt = await readStdin();
  }
  if (!prompt) {
    printUsage();
    process.exit(1);
  }

  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const permission = normalizePermission(options.permission);
  const env: Record<string, string | undefined> = { ...process.env, EVE_HARNESS_NAME: harness };
  const { command, warnings } = adapter.buildCommand({
    harness,
    prompt,
    permission,
    variant: options.variant,
    model: options.model,
    reasoning: options.reasoning,
    env,
    workspace,
  });
  if (command.env.CLAUDE_CONFIG_DIR) {
    await ensureDir(command.env.CLAUDE_CONFIG_DIR);
  }
  if (command.env.CODEX_HOME) {
    await ensureDir(command.env.CODEX_HOME);
  }
  if (command.env.PI_HOME) {
    await ensureDir(path.join(command.env.PI_HOME, 'agent'));
  }

  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }

  // Emit startup event with full command for debugging/audit
  const startupEvent: NormalizedEvent = {
    seq: 0,
    ts: new Date().toISOString(),
    kind: 'system',
    raw: {
      type: 'harness_startup',
      binary: command.binary,
      args: command.args,
      workspace,
      harness,
      permission,
      command_line: `${command.binary} ${command.args.join(' ')}`,
    },
  };
  emitEvent(startupEvent);

  const child = spawn(command.binary, command.args, {
    cwd: workspace,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let seq = 0;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const llmCall = maybeBuildLlmCallEvent(parsed, { harness, model: options.model, env: command.env });
      if (llmCall) {
        emitRawEvent(llmCall as unknown as Record<string, unknown>);
      }
      const event = buildEvent(++seq, parsed);
      emitEvent(event);
    } catch (error) {
      const raw = {
        type: 'parse_error',
        error: error instanceof Error ? error.message : String(error),
        content: line,
      };
      const event = buildEvent(++seq, raw);
      emitEvent(event);
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString('utf-8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const raw = { type: 'stderr', content: line };
      const event = buildEvent(++seq, raw);
      emitEvent(event);
    }
  });

  child.on('exit', (code, signal) => {
    if (code !== null) {
      process.exit(code);
    }
    // Signal-killed: use Unix convention (128 + signal number)
    const signalCodes: Record<string, number> = {
      SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3,
    };
    const sigNum = signal ? (signalCodes[signal] ?? 1) : 1;
    process.exit(128 + sigNum);
  });

  child.on('error', (error) => {
    const raw = { type: 'spawn_error', error: error.message };
    const event = buildEvent(++seq, raw);
    emitEvent(event);
    process.exit(1);
  });
}

main().catch((error) => {
  const raw = {
    type: 'proxy_error',
    error: error instanceof Error ? error.message : String(error),
  };
  const event: NormalizedEvent = {
    seq: 1,
    ts: new Date().toISOString(),
    kind: 'error',
    error: raw.error,
    raw,
  };
  emitEvent(event);
  process.exit(1);
});
