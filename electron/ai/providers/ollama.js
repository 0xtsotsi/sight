// Ollama provider. Fully offline, no API key required — talks to the local
// daemon over fetch. Falls back to the plain `/api/chat` text shape with
// lightweight JSON extraction: Ollama's structured-output support varies
// by model, so we ask for JSON in the prompt and parse what we get.

const { OLLAMA_DEFAULT_ENDPOINT } = require('./registry.js');

const SYSTEM_PROMPT = `You are editing a single Astro component node inside a visual page builder.

Hard constraints:
- You may ONLY modify the selected node's own props, children, and its contribution to the page frontmatter.
- You MUST NOT change imports, scripts, styles, or unrelated nodes.
- You MUST NOT add new top-level frontmatter keys that didn't exist on the original node.
- You MUST NOT add new prop keys that didn't exist on the original node.
- Children content must stay close in length to the original (no more than 50% change).
- Output a single JSON object only, with no surrounding prose or markdown fences.
- Use these fields exactly: { "frontmatter": object|null, "props": object|null, "children": array|null, "reason": string }.
- If a field should be left unchanged, set it to null.

If the user's instruction cannot be honoured without violating a constraint, return {"frontmatter":null,"props":null,"children":null,"reason":"<why>"}.`;

// Best-effort: peel off ```json fences if the model added them anyway.
function extractJson(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      return JSON.parse(t);
    } catch {
      /* fallthrough */
    }
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  // Last resort: first balanced {...} block.
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function createOllamaProvider({ endpoint, model } = {}) {
  const base = (endpoint || OLLAMA_DEFAULT_ENDPOINT).replace(/\/$/, '');

  return {
    id: 'ollama',

    async *streamPatch({ node, instruction, history, signal } = {}) {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      if (Array.isArray(history)) {
        for (const h of history) {
          if (!h || !h.role || !h.content) continue;
          const role = h.role === 'assistant' ? 'assistant' : 'user';
          messages.push({ role, content: String(h.content) });
        }
      }
      messages.push({
        role: 'user',
        content:
          'Selected node (JSON):\n' +
          JSON.stringify(node, null, 2) +
          '\n\nUser instruction:\n' +
          String(instruction || ''),
      });

      const body = {
        model: model || 'llama3.2',
        messages,
        stream: true,
      };

      let res;
      try {
        res = await fetch(base + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        const msg = err?.message || String(err);
        yield {
          type: 'error',
          message:
            'Could not reach Ollama at ' +
            base +
            '. Start the daemon (`ollama serve`) or change the endpoint in AI settings. (' +
            msg +
            ')',
        };
        yield { type: 'done' };
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        yield {
          type: 'error',
          message: 'Ollama returned HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : ''),
        };
        yield { type: 'done' };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';

      try {
        while (true) {
          if (signal?.aborted) break;
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            const chunk = obj?.message?.content || obj?.response || '';
            if (chunk) {
              assembled += chunk;
              yield { type: 'delta', text: chunk };
            }
            if (obj?.done) {
              // Drain reader so the connection is released.
              try {
                await reader.cancel();
              } catch {
                /* ignore */
              }
              break;
            }
          }
          if (signal?.aborted) break;
        }
      } catch (err) {
        yield { type: 'error', message: err?.message || String(err) };
        yield { type: 'done' };
        return;
      }

      const patch = extractJson(assembled);
      if (!patch) {
        yield { type: 'error', message: 'Ollama did not return a parseable patch.' };
        yield { type: 'done' };
        return;
      }
      yield { type: 'patch', patch, text: assembled };
      yield { type: 'done' };
    },
  };
}

module.exports = { createOllamaProvider, extractJson };