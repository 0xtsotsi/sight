// OpenAI provider adapter. Uses the Responses API with a structured-output
// json_schema constraint. Returns the same shape as the Anthropic adapter
// so the rest of the AI pipeline can be provider-agnostic.

const { getPatchSchema } = require('./registry.js');

function defaultCreateClient(apiKey, baseURL) {
  const OpenAI = require('openai');
  return new OpenAI({ apiKey, baseURL });
}

const SYSTEM_PROMPT = `You are editing a single Astro component node inside a visual page builder.

Hard constraints:
- You may ONLY modify the selected node's own props, children, and its contribution to the page frontmatter.
- You MUST NOT change imports, scripts, styles, or unrelated nodes.
- You MUST NOT add new top-level frontmatter keys that didn't exist on the original node.
- You MUST NOT add new prop keys that didn't exist on the original node.
- Children content must stay close in length to the original (no more than 50% change).
- Output a structured patch object that matches the provided schema. Do not output anything else.

If the user's instruction cannot be honoured without violating a constraint, return a patch whose \`reason\` explains why and leave \`props\` / \`children\` / \`frontmatter\` as \`null\`.`;

function buildInput({ node, instruction, history }) {
  const items = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (!h || !h.role || !h.content) continue;
      if (h.role !== 'user' && h.role !== 'assistant') continue;
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      items.push({ role, content: [{ type: 'input_text', text: String(h.content) }] });
    }
  }
  items.push({
    role: 'user',
    content: [
      {
        type: 'input_text',
        text:
          'Selected node (JSON):\n' +
          JSON.stringify(node, null, 2) +
          '\n\nUser instruction:\n' +
          String(instruction || ''),
      },
    ],
  });
  return items;
}

function createOpenAIProvider({ apiKey, model, baseURL, client, _createClient } = {}) {
  if (!apiKey) throw new Error('Missing OpenAI API key');
  const sdk =
    client || (typeof _createClient === 'function' ? _createClient(apiKey, baseURL) : defaultCreateClient(apiKey, baseURL));

  return {
    id: 'openai',

    async *streamPatch({ node, instruction, history, signal } = {}) {
      const input = buildInput({ node, instruction, history });
      const params = {
        model: model || 'gpt-4o',
        instructions: SYSTEM_PROMPT,
        input,
        text: {
          format: {
            type: 'json_schema',
            name: 'ai_patch',
            schema: getPatchSchema(),
            strict: true,
          },
        },
      };

      let stream;
      try {
        stream = await sdk.responses.stream(params, { signal });
      } catch (err) {
        const msg = err?.message || String(err);
        yield { type: 'error', message: redactMessage(msg) };
        yield { type: 'done' };
        return;
      }

      let assembled = '';
      try {
        for await (const event of stream) {
          if (signal?.aborted) break;
          if (event.type === 'response.output_text.delta') {
            assembled += event.delta || '';
            yield { type: 'delta', text: event.delta || '' };
          } else if (event.type === 'response.error') {
            yield { type: 'error', message: redactMessage(event.message || 'Provider error') };
            yield { type: 'done' };
            return;
          } else if (event.type === 'response.failed') {
            yield { type: 'error', message: redactMessage(event.response?.error?.message || 'Provider failed') };
            yield { type: 'done' };
            return;
          }
        }
      } catch (err) {
        const msg = err?.message || String(err);
        yield { type: 'error', message: redactMessage(msg) };
        yield { type: 'done' };
        return;
      }

      let patch = null;
      if (assembled) {
        try {
          patch = JSON.parse(assembled);
        } catch {
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
      yield { type: 'patch', patch, text: assembled };
      yield { type: 'done' };
    },
  };
}

function redactMessage(msg) {
  if (!msg) return msg;
  let s = String(msg);
  s = s.replace(/sk-[A-Za-z0-9_\-]+/g, '[REDACTED]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"'\s,]+/gi, '$1[REDACTED]');
  s = s.replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,]+/gi, '$1[REDACTED]');
  return s;
}

module.exports = { createOpenAIProvider, redactMessage };