// src/agent/types.js
//
// Canonical event-type enum for the AgentPanel stream. This is the single
// source of truth shared between the client (task 3), the panel (task 4),
// and the apply flow (task 6). Each event has a stable `type` string that
// the panel switches on.
//
// Wire shape on the panel side:
//   {type: 'text',       delta: string}
//   {type: 'tool',       name: string, args: unknown, status: 'started'|'update'|'done'|'error',
//                        toolCallId: string, result?: unknown, error?: string, durationMs?: number}
//   {type: 'diff',       path: string, summary: string, unifiedDiff: string|null,
//                        beforeJson: unknown, afterJson: unknown}
//   {type: 'thinking',   delta: string}
//   {type: 'retry',      reason: string, attempt: number, maxAttempts: number, delayMs: number}
//   {type: 'truncated',  reason: 'max_tokens'|'refusal'|'provider_error'}
//   {type: 'checkpoint', turn: number}              // safe persistence point
//   {type: 'turn_end',   turn: number, usage: object}
//   {type: 'done',       totalTurns: number, totalUsage: object}
//   {type: 'max_turns',  totalTurns: number, maxTurns: number}
//   {type: 'error',      message: string}
//
// Translating from gg-agent's events to these is the client's job; see
// translateEvent() in client.js.

export const EVENT = Object.freeze({
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL: 'tool',
  DIFF: 'diff',
  RETRY: 'retry',
  TRUNCATED: 'truncated',
  CHECKPOINT: 'checkpoint',
  TURN_END: 'turn_end',
  DONE: 'done',
  MAX_TURNS: 'max_turns',
  ERROR: 'error',
});

export const TOOL_STATUS = Object.freeze({
  STARTED: 'started',
  UPDATE: 'update',
  DONE: 'done',
  ERROR: 'error',
});

// Shared provider list. gg-ai accepts these strings (see Provider union in
// node_modules/@kenkaiiii/gg-ai/dist/index.d.ts:5). We re-export the subset
// the panel needs so it doesn't need to know gg-ai's types.
export const PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'gemini',
  'minimax',
]);

/**
 * @typedef {Object} AgentEvent
 * @property {string} type - one of EVENT.*
 * @property {*} [delta]              - for TEXT/THINKING
 * @property {string} [name]          - for TOOL
 * @property {*} [args]
 * @property {string} [status]        - TOOL_STATUS.*
 * @property {string} [toolCallId]
 * @property {*} [result]
 * @property {string} [error]
 * @property {number} [durationMs]
 * @property {string} [path]          - for DIFF
 * @property {string} [summary]
 * @property {string|null} [unifiedDiff]
 * @property {*} [beforeJson]
 * @property {*} [afterJson]
 * @property {string} [reason]        - for RETRY/TRUNCATED/ERROR
 * @property {number} [attempt]
 * @property {number} [maxAttempts]
 * @property {number} [delayMs]
 * @property {number} [turn]
 * @property {number} [totalTurns]
 * @property {number} [maxTurns]
 * @property {object} [usage]
 * @property {object} [totalUsage]
 * @property {string} [message]       - for ERROR
 */
