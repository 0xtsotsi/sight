// Central provider registry. Single source of truth for the list exposed to
// the renderer through `ai:providers`. Keys live in main only — this file
// never sees them.

const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
const OPENAI_DEFAULT_MODEL = 'gpt-4o';
const OLLAMA_DEFAULT_MODEL = 'llama3.2';
const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

// Stable provider ids — never reorder, never rename. Used as keys for
// safeStorage and in IPC payloads.
const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    requiresKey: true,
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    models: [ANTHROPIC_DEFAULT_MODEL],
    endpoint: 'https://api.anthropic.com',
    structuredOutputs: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    requiresKey: true,
    defaultModel: OPENAI_DEFAULT_MODEL,
    models: [OPENAI_DEFAULT_MODEL],
    endpoint: 'https://api.openai.com',
    structuredOutputs: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    requiresKey: false,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    // Most useful code-oriented local models. Ollama will accept anything
    // the user has pulled — we just list a few common defaults.
    models: [OLLAMA_DEFAULT_MODEL, 'qwen2.5-coder', 'llama3.1', 'mistral'],
    endpoint: OLLAMA_DEFAULT_ENDPOINT,
    structuredOutputs: false,
  },
];

function listProviders() {
  // Strip fields that aren't useful to the renderer (no internal endpoint
  // details, no internal flag names).
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    requiresKey: p.requiresKey,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
}

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function defaultModelFor(id) {
  const p = getProvider(id);
  return p ? p.defaultModel : null;
}

function modelsFor(id) {
  const p = getProvider(id);
  return p ? p.models.slice() : [];
}

// The structured patch shape we constrain every provider to return. Used as
// the source for both Anthropic JSON Schema and OpenAI json_schema. Any
// patch that doesn't conform is rejected before it ever reaches apply.js.
const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    frontmatter: {
      type: ['object', 'null'],
      description:
        "Replaces the node's contribution to the page frontmatter. Pass null to leave frontmatter unchanged. Keys not present in the original node's frontmatter may NOT be added.",
      additionalProperties: { type: 'string' },
    },
    props: {
      type: ['object', 'null'],
      description:
        'Replaces the props object on the node. Pass null to leave props unchanged. Keys not present in the original node may NOT be added.',
      additionalProperties: true,
    },
    children: {
      type: ['array', 'null'],
      description:
        'Replaces the children array. Pass null to leave children unchanged.',
    },
    reason: {
      type: 'string',
      description: 'One-sentence explanation of what changed and why.',
    },
  },
  required: ['reason'],
};

// JSON-schema serialization for tool-use inputs. Anthropic's structured-
// output constraint takes the schema as a string in `tool.input_schema` or
// the top-level `output_format`. OpenAI's json_schema takes it as a JSON
// object. Both formats share the same shape object so we can hand it to
// either provider.
function getPatchSchema() {
  return PATCH_SCHEMA;
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  defaultModelFor,
  modelsFor,
  getPatchSchema,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_ENDPOINT,
};