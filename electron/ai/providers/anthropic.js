// Anthropic provider adapter. Returns an async iterable of patch events:
//   { type: 'delta', text }           — partial assistant text
//   { type: 'patch', patch }          — final structured patch
//   { type: 'error', message }        — fatal error (iterator ends)
//   { type: 'done' }                  — terminal event
//
// The provider uses Anthropic's Messages API with structured outputs
// (tool-use with a JSON-Schema input_schema). Keys live only in main; this
// adapter takes the decrypted key as an argument from the caller.

const { getPatchSchema } = require('./registry.js');

// Lazy-require the SDK so the adapter can be imported from a context
// (e.g. an ESM test) where the SDK isn't resolved yet. We also accept
// `client` as a constructor argument for dependency injection in tests.
function defaultCreateClient(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

const SYSTEM_PROMPT = `You are editing a single Astro component node inside a visual page builder.

Hard constraints:
- You may ONLY modify the selected node's own props, children, and its contribution to the page frontmatter.
- You MUST NOT change imports, scripts, styles, or unrelated nodes.
- You MUST NOT add new top-level frontmatter keys that didn't exist on the original node.
- You MUST NOT add new prop keys that didn't exist on the original node.
- Children content must stay close in length to the original (no more than 50% change).
- Output a structured patch object that matches the schema. Do not output anything else.

If the user's instruction cannot be honoured without violating a constraint, return a patch whose \`reason\` explains why and leave \`props\` / \`children\` / \`frontmatter\` as \`null\`.`;

function buildMessages({ node, instruction, history }) {
  const user = {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'Selected node (JSON):\n' +
          JSON.stringify(node, null, 2) +
          '\n\nUser instruction:\n' +
          String(instruction || ''),
      },
    ],
  };
  const turns = [];
  // Prior turns are flattened into a single preceding user/assistant pair
  // so we don't need to thread full message ids — they're for context only.
  if (Array.isArray(history)) {
    for (const h of history) {
      if (!h || !h.role || !h.content) continue;
      turns.push({ type: 'message', role: h.role, content: [{ type: 'text', text: String(h.content) }] });
    }
  }
  turns.push(user);
  return turns;
}

function createAnthropicProvider({ apiKey, model, client, _createClient } = {}) {
  if (!apiKey) throw new Error('Missing Anthropic API key');
  const sdk = client || (typeof _createClient === 'function' ? _createClient(apiKey) : defaultCreateClient(apiKey));

  return {
    id: 'anthropic',

    async *streamPatch({ node, instruction, history, signal } = {}) {
      const messages = buildMessages({ node, instruction, history });
      const params = {
        model: model || 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: 'emit_patch',
            description:
              'Emit the structured patch describing changes to the selected node.',
            input_schema: getPatchSchema(),
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_patch' },
        messages,
      };

      let stream;
      try {
        stream = await sdk.messages.stream(params, { signal });
      } catch (err) {
        const msg = err?.message || String(err);
        yield { type: 'error', message: redactMessage(msg) };
        yield { type: 'done' };
        return;
      }

      let pendingText = '';
      let toolInputJson = '';

      try {
        for await (const event of stream) {
          if (signal?.aborted) break;
          switch (event.type) {
            case 'content_block_start': {
              const block = event.content_block;
              if (block?.type === 'text') pendingText = '';
              else if (block?.type === 'tool_use') toolInputJson = '';
              break;
            }
            case 'content_block_delta': {
              const delta = event.delta;
              if (!delta) break;
              if (delta.type === 'text_delta') {
                pendingText += delta.text || '';
                yield { type: 'delta', text: delta.text || '' };
              } else if (delta.type === 'input_json_delta') {
                toolInputJson += delta.partial_json || '';
              }
              break;
            }
            case 'content_block_stop':
            case 'message_stop':
            case 'message_delta':
            default:
              break;
          }
        }
      } catch (err) {
        const msg = err?.message || String(err);
        yield { type: 'error', message: redactMessage(msg) };
        yield { type: 'done' };
        return;
      }

      let patch = null;
      if (toolInputJson) {
        try {
          patch = JSON.parse(toolInputJson);
        } catch (err) {
          yield { type: 'error', message: 'Provider returned malformed JSON.' };
          yield { type: 'done' };
          return;
        }
      }
      if (!patch) {
        yield { type: 'error', message: 'Provider did not return a structured patch.' };
        yield { type: 'done' };
        return;
      }
      yield { type: 'patch', patch, text: pendingText };
      yield { type: 'done' };
    },
  };
}

// Never let the API key or auth header leak through an error message. We
// deliberately redact anything that looks like sk-ant-* and any 'x-api-key'
// value that ended up in an exception string.
function redactMessage(msg) {
  if (!msg) return msg;
  let s = String(msg);
  s = s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[REDACTED]');
  s = s.replace(/(x-api-key["']?\s*[:=]\s*["']?)[^"'\s,]+/gi, '$1[REDACTED]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)[^"'\s,]+/gi, '$1[REDACTED]');
  return s;
}

module.exports = { createAnthropicProvider, redactMessage };