// src/agent/client.js
//
// Wraps @kenkaiiii/gg-agent + @kenkaiiii/gg-ai and exposes a single async
// generator runAgentStream({messages, snapshot, signal}) that yields the
// panel-facing event types defined in src/agent/types.js.
//
// What lives here:
//   - buildMessageHistory: turns a flat panel message list into gg-ai's
//     Message[] shape.
//   - resolveProvider: maps a credential into gg-ai's `provider` union.
//   - adaptToolsForAgent: takes buildTools() output (MCP-shaped) and wraps
//     each handler so the per-call `ctx` is injected from `snapshot`.
//   - runAgentStream: the main entry point — sets up the Agent, runs
//     agentLoop, translates each AgentEvent to the panel-facing shape.
//
// What does NOT live here:
//   - The apply/dispatch path (lives in App.jsx + AgentPanel — task 5).
//   - Diff computation (lives in src/agent/diff.js — task 6).
//   - The credential read (handled by the IPC verb in main.js — the
//     renderer accepts the credential as an arg so this file stays pure).

import { agentLoop, isAbortError } from '@kenkaiiii/gg-agent';
import { buildTools } from './tools.js';
import { EVENT, PROVIDERS } from './types.js';

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

const PROVIDER_ALIASES = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  gpt: 'openai',
  gemini: 'gemini',
  google: 'gemini',
  minimax: 'minimax',
};

/**
 * Map a credential's stored `provider` string to the gg-ai Provider union.
 * Returns null if the provider isn't supported by the agent panel.
 */
export function resolveProvider(storedProvider) {
  if (!storedProvider) return null;
  const key = String(storedProvider).toLowerCase().trim();
  const canonical = PROVIDER_ALIASES[key];
  if (!canonical) return null;
  return PROVIDERS.includes(canonical) ? canonical : null;
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Convert a flat panel message list into gg-ai's Message[]. Panel messages
 * are {role: 'user'|'assistant', content: string|Array<{kind:'text'|'image',...}>}.
 * For now we only support text — image input lands in a follow-up.
 */
export function buildMessageHistory(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b) => b?.kind === 'text').map((b) => b.text).join('\n')
          : '';
      if (!text) continue;
      out.push({ role: 'user', content: [{ type: 'text', text }] });
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (!text) continue;
      out.push({ role: 'assistant', content: [{ type: 'text', text }] });
    }
    // System messages aren't passed through here — the system prompt is
    // built separately in src/agent/systemPrompt.js (task 5).
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool adaptation
//
// tools.js exports MCP-shaped {name, description, inputSchema, handler}.
// gg-agent wants AgentTool<T> with a zod `parameters` schema and an
// `execute(args, context)` method. We wrap each handler so it receives the
// per-call snapshot as a second arg, matching the contract tools.js expects.
// ---------------------------------------------------------------------------

async function adaptToolsForAgent(snapshot) {
  const tools = buildTools();
  const adapted = [];
  for (const t of tools) {
    // We don't strictly need the JSON Schema for gg-agent (it uses the
    // zod parameters), but we keep the tool's `name` and `description`
    // for the LLM. The handler closure captures `snapshot` so every call
    // gets the right projectPath/selection — see tools.js for the ctx
    // contract.
    adapted.push({
      name: t.name,
      description: t.description,
      // gg-agent expects a zod schema in `parameters`; tools.js owns the
      // zod schemas in src/agent/schemas.js. We re-import them here so the
      // agent gets the same validation the tools layer already enforces.
      parameters: await loadZodSchema(t.name),
      execute: async (args, _context) => {
        const result = await t.handler(args, snapshot);
        // gg-agent expects tool results as strings or {content, details}.
        // We always serialize as a JSON string and attach the structured
        // payload under `details` so the panel can re-parse for diff cards.
        if (t.name === 'apply_page_diff') {
          return {
            content: [{ type: 'text', text: `Proposed change ready for review: ${result.summary}` }],
            details: result,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
  }
  return adapted;
}

// Cached schema lookup keyed by tool name.
const SCHEMA_LOADERS = {};
async function loadZodSchema(name) {
  if (SCHEMA_LOADERS[name]) return SCHEMA_LOADERS[name];
  const mod = await import('./schemas.js');
  const map = {
    list_pages: mod.listPagesArgsSchema,
    read_page: mod.readPageArgsSchema,
    read_cms: mod.readCmsArgsSchema,
    scan_project: mod.scanProjectArgsSchema,
    apply_page_diff: mod.applyPageDiffArgsSchema,
  };
  SCHEMA_LOADERS[name] = map[name];
  return map[name];
}

// ---------------------------------------------------------------------------
// Event translation
//
// gg-agent's AgentEvent union is rich (see gg-agent/dist/index.d.ts:188).
// We map each kind to the panel-facing shape in types.js. Anything we
// don't care about is dropped silently.
// ---------------------------------------------------------------------------

function translateEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.type) {
    case 'text_delta':
      return { type: EVENT.TEXT, delta: String(ev.text ?? '') };

    case 'thinking_delta':
      return { type: EVENT.THINKING, delta: String(ev.text ?? '') };

    case 'tool_call_start':
      return {
        type: EVENT.TOOL,
        name: ev.name,
        args: ev.args,
        status: 'started',
        toolCallId: ev.toolCallId,
      };

    case 'tool_call_update':
      return {
        type: EVENT.TOOL,
        name: undefined, // updates don't carry the name; the panel joins on toolCallId
        status: 'update',
        toolCallId: ev.toolCallId,
        update: ev.update,
      };

    case 'tool_call_end': {
      const out = {
        type: EVENT.TOOL,
        status: ev.isError ? 'error' : 'done',
        toolCallId: ev.toolCallId,
        durationMs: ev.durationMs,
      };
      if (ev.isError) {
        out.error = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
      } else {
        out.result = ev.result;
        out.details = ev.details;
      }
      // If the finished tool was apply_page_diff, surface a diff event so
      // the panel can render the Apply/Reject card. The tool's execute()
      // already wrapped the diff payload in `details`.
      if (ev.details && typeof ev.details === 'object' && 'diff' in ev.details) {
        return [
          out,
          {
            type: EVENT.DIFF,
            path: ev.details.path,
            summary: ev.details.summary,
            unifiedDiff: ev.details.diff?.unifiedDiff ?? null,
            beforeJson: ev.details.beforeJson,
            afterJson: ev.details.afterJson,
          },
        ];
      }
      return out;
    }

    case 'retry':
      return {
        type: EVENT.RETRY,
        reason: ev.reason,
        attempt: ev.attempt,
        maxAttempts: ev.maxAttempts,
        delayMs: ev.delayMs,
      };

    case 'truncated':
      return { type: EVENT.TRUNCATED, reason: ev.reason };

    case 'checkpoint':
      return { type: EVENT.CHECKPOINT, turn: ev.turn };

    case 'turn_end':
      return { type: EVENT.TURN_END, turn: ev.turn, usage: ev.usage };

    case 'agent_done':
      return { type: EVENT.DONE, totalTurns: ev.totalTurns, totalUsage: ev.totalUsage };

    case 'max_turns':
      return { type: EVENT.MAX_TURNS, totalTurns: ev.totalTurns, maxTurns: ev.maxTurns };

    case 'error':
      return {
        type: EVENT.ERROR,
        message: ev.error?.message ?? String(ev.error ?? 'unknown agent error'),
      };

    // server_tool_call / server_tool_result / steering / follow_up:
    // not used by the Sight panel right now — drop silently.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {Object}   args
 * @param {Array}    args.messages         - panel message list (see buildMessageHistory)
 * @param {Object}   args.snapshot         - {projectPath, selectedNodeId?, activePagePath?}
 * @param {string}   [args.systemPrompt]   - pre-built system prompt (task 5)
 * @param {string}   [args.model]          - override model id (defaults per provider)
 * @param {AbortSignal} [args.signal]
 * @param {Object}   args.credential     - {provider, apiKey} from window.avb.getAgentCredential
 * @returns {AsyncGenerator<Object>}
 */
export async function* runAgentStream({
  messages,
  snapshot,
  systemPrompt,
  model,
  signal,
  credential,
} = {}) {
  if (!snapshot || typeof snapshot.projectPath !== 'string' || !snapshot.projectPath) {
    yield { type: EVENT.ERROR, message: 'runAgentStream: snapshot.projectPath is required' };
    return;
  }

  const cred = credential;
  if (!cred || !cred.apiKey) {
    yield {
      type: EVENT.ERROR,
      message:
        'No provider API key configured. Add MINIMAX_API_KEY to ~/.gg/settings.json ' +
        'or run `ggcoder login` to populate ~/.gg/auth.json.',
    };
    return;
  }
  const provider = resolveProvider(cred.provider);
  if (!provider) {
    yield {
      type: EVENT.ERROR,
      message: `Unsupported provider: ${cred.provider}. Supported: ${PROVIDERS.join(', ')}.`,
    };
    return;
  }

  const tools = await adaptToolsForAgent(snapshot);
  const priorMessages = buildMessageHistory(messages);

  let stream;
  try {
    stream = agentLoop(priorMessages, {
      provider,
      model: model ?? defaultModelFor(provider),
      apiKey: cred.apiKey,
      system: systemPrompt,
      tools,
      signal,
      // Conservative defaults; revisit once we have data.
      maxTurns: 25,
      maxTokens: 8192,
    });
  } catch (err) {
    yield { type: EVENT.ERROR, message: `Failed to start agent: ${err?.message ?? err}` };
    return;
  }

  try {
    for await (const ev of stream) {
      const translated = translateEvent(ev);
      if (translated == null) continue;
      if (Array.isArray(translated)) {
        for (const t of translated) yield t;
      } else {
        yield translated;
      }
      if (translated.type === EVENT.DONE || translated.type === EVENT.MAX_TURNS) {
        return;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      // Cancellation isn't an error from the panel's perspective.
      return;
    }
    yield { type: EVENT.ERROR, message: err?.message ?? String(err) };
  }
}

function defaultModelFor(provider) {
  switch (provider) {
    case 'anthropic': return 'claude-sonnet-4-5';
    case 'openai': return 'gpt-4o';
    case 'gemini': return 'gemini-2.5-pro';
    case 'minimax': return 'MiniMax-M3';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  translateEvent,
  defaultModelFor,
};
