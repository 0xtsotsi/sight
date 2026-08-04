// src/agent/skills.js
//
// Phase 5: portable skills library for the Impeccable-first Design
// Agent. A skill is a named bundle of { instructions, allowedTools,
// invocation policy, license } that the model can pick up at session
// time. The model never sees raw file paths or a global skill store —
// it sees a typed catalog returned by `listSkillSummaries()` and a
// `runSkill(name)` entry that injects the skill's instructions into the
// next agent turn.
//
// Schema (skill.toml / skill.json — frontmatter supported too):
//   {
//     schemaVersion: 1,
//     name: 'brand-guardian',
//     version: '1.0.0',
//     license: 'Apache-2.0',
//     compatibility: { sight: '>=0.1.0' },
//     description: 'Keeps every page on-brand before publish.',
//     userInvocable: true,
//     modelInvocable: true,
//     argumentHint: '[--scope=page|site]',
//     instructions: 'You are a brand guardian. Before approving any
//                    change, validate the new copy against the
//                    DESIGN.md and the project\'s voice.',
//     allowedTools: ['list_pages', 'read_page', 'read_cms', 'apply_page_diff'],
//     metadata: { author: '...', url: '...' },
//   }
//
// `validateSkill()` is the single source of truth for what's a valid
// skill. It returns `{ ok: true, skill } | { ok: false, issues: [...] }`.
// `intersectWithHost()` filters the skill's allowedTools against the
// runtime tool manifest so a malicious or stale skill cannot call tools
// the host does not expose.
//
// Skills in the catalog are immutable from the agent's perspective:
// the user installs / removes them via the panel; the agent only
// invokes them through `runSkill(name, args)`.

import { z } from 'zod';
import { listToolNames } from './policy.js';

// ---------------------------------------------------------------------------
// Bundled skills — the seed catalog. Skills added here ship with Sight
// and are always available. User-installed skills are loaded at
// runtime from <userData>/skills/ (Phase 5 panel wiring only; this
// module exposes the loaders so the panel can call them).
// ---------------------------------------------------------------------------

const BUNDLED = Object.freeze([
  {
    schemaVersion: 1,
    name: 'impeccable-design-guardian',
    version: '1.0.0',
    license: 'Apache-2.0',
    compatibility: { sight: '>=0.1.0' },
    description: 'Validates every proposed edit against the Impeccable design standard and the project brief before the user sees it.',
    userInvocable: true,
    modelInvocable: true,
    argumentHint: '[--phase=build|polish|finish]',
    instructions:
      'You are the Impeccable design guardian. Before any tool call, read the brief and the project\'s DESIGN.md (if present) and the active workflow step. ' +
      'Refuse to propose edits that: (a) blend refine with redesign without the user\'s explicit consent; ' +
      '(b) introduce hard-coded type sizes or colors that are not bound to tokens; ' +
      '(c) fabricate testimonials, metrics, or names; ' +
      '(d) decorate without serving the surface intent. ' +
      'Always surface the rationale in the panel so the user can override.',
    allowedTools: ['list_pages', 'read_page', 'read_cms', 'scan_project', 'apply_page_diff', 'run_live_review'],
    metadata: { author: 'Sight', url: 'https://github.com/pbakaus/impeccable' },
  },
  {
    schemaVersion: 1,
    name: 'higgsfield-media-brief',
    version: '1.0.0',
    license: 'Apache-2.0',
    compatibility: { sight: '>=0.1.0' },
    description: 'Drafts Higgsfield media requests with the prompt + reference image + aspect ratio the renderer needs to render correctly.',
    userInvocable: true,
    modelInvocable: false,
    argumentHint: '<image|video|thumbnail|brandkit> [prompt]',
    instructions:
      'You are a Higgsfield media drafter. When the user asks for an image, video, thumbnail, or brand kit, produce a structured request that ' +
      'includes (1) the kind, (2) a 1-sentence intent, (3) the prompt, (4) any reference image ids, (5) the aspect ratio, and (6) the license terms ' +
      'the user must accept. Never invent Higgsfield-only fields that are not in the public API. Never request destructive or paid actions without ' +
      'explicit user consent.',
    allowedTools: ['generate_image', 'generate_video', 'generate_thumbnail', 'pull_brandkit'],
    metadata: { author: 'Sight' },
  },
  {
    schemaVersion: 1,
    name: 'background-task-runner',
    version: '1.0.0',
    license: 'Apache-2.0',
    compatibility: { sight: '>=0.1.0' },
    description: 'Spins up isolated worktree-backed agent runs for broad tasks, then reports back without disturbing the user\'s active editor.',
    userInvocable: true,
    modelInvocable: true,
    argumentHint: '<brief>',
    instructions:
      'You are the background-task runner. When the user asks for work that touches more than a few files, that may run for a while, or that should not ' +
      'disturb the user\'s current state, propose opening a worktree-backed background task. Surface the worktree path, the branch, the base SHA, and ' +
      'the list of dirty files that will be carried. Wait for explicit user approval before opening. Always finalize with one of: discard, merge, keep. ' +
      'Never auto-merge.',
    allowedTools: ['open_background_task', 'finalize_background_task', 'list_background_tasks', 'capture_evidence', 'run_live_review'],
    metadata: { author: 'Sight' },
  },
]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const toolNameSchema = z.string().refine(
  (n) => listToolNames().includes(n),
  (n) => ({ message: 'unknown tool: ' + String(n) }),
);

const skillSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, 'name must be kebab-case ascii'),
  version: z.string().min(1).max(40),
  license: z.string().min(1).max(80),
  compatibility: z.object({ sight: z.string() }).optional(),
  description: z.string().min(1).max(400),
  userInvocable: z.boolean().default(true),
  modelInvocable: z.boolean().default(false),
  argumentHint: z.string().max(200).optional(),
  instructions: z.string().min(1).max(20000),
  allowedTools: z.array(toolNameSchema).max(50),
  metadata: z.object({ author: z.string().optional(), url: z.string().url().optional() }).optional(),
});

/**
 * Validate a skill object. Returns `{ ok: true, skill }` on success or
 * `{ ok: false, issues: string[] }` on failure. Never throws.
 */
export function validateSkill(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, issues: ['skill must be an object'] };
  }
  const r = skillSchema.safeParse(obj);
  if (!r.success) {
    const issues = r.error.issues.map((i) => i.path.join('.') + ': ' + i.message);
    return { ok: false, issues };
  }
  return { ok: true, skill: r.data };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const userCatalog = []; // pushed by loadUserSkills() at runtime

/**
 * List all available skills, including the bundled catalog plus any
 * user-installed skills. Returns a sorted, frozen array.
 */
export function listSkills() {
  const merged = [...BUNDLED, ...userCatalog];
  return Object.freeze(merged.slice().sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * Look up a skill by name. Returns the skill or null.
 */
export function getSkill(name) {
  if (typeof name !== 'string' || !name) return null;
  return listSkills().find((s) => s.name === name) ?? null;
}

/**
 * Lightweight summaries for the gallery. Strips the (potentially long)
 * instructions field so the panel can render the list quickly.
 */
export function listSkillSummaries() {
  return listSkills().map((s) => ({
    name: s.name,
    version: s.version,
    description: s.description,
    userInvocable: s.userInvocable,
    modelInvocable: s.modelInvocable,
    argumentHint: s.argumentHint ?? '',
    toolCount: s.allowedTools.length,
    license: s.license,
  }));
}

// ---------------------------------------------------------------------------
// Loader — supports TOML-like JSON for now (TOML parser can land in
// Phase 5b). The bundled skills are checked in; user skills are loaded
// from <userData>/skills/*.json and validated on load.
// ---------------------------------------------------------------------------

/**
 * Load a user skill from a raw object. Validates and, on success,
 * registers it for the session. Returns `{ ok, skill | issues }`.
 */
export function loadUserSkill(obj) {
  const v = validateSkill(obj);
  if (!v.ok) return v;
  // Replace existing same-name entry or append.
  const idx = userCatalog.findIndex((s) => s.name === v.skill.name);
  if (idx >= 0) userCatalog[idx] = v.skill;
  else userCatalog.push(v.skill);
  return { ok: true, skill: v.skill };
}

/**
 * Remove a user-installed skill by name. Bundled skills cannot be
 * removed. Returns true if removed, false if not found.
 */
export function unloadUserSkill(name) {
  const idx = userCatalog.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  userCatalog.splice(idx, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Host intersection — the skill's allowedTools ∩ runtime tool manifest.
// A skill that asks for an unknown tool gets a warning AND the unknown
// tool is dropped from the effective set.
// ---------------------------------------------------------------------------

/**
 * Compute the effective allowedTools for a skill against the current
 * runtime tool manifest. Returns `{ allowed: string[], dropped: string[] }`.
 * The caller is responsible for refusing to invoke the skill if
 * `dropped.length > 0` and the policy says so.
 */
export function intersectWithHost(skill) {
  const known = new Set(listToolNames());
  const allowed = [];
  const dropped = [];
  for (const t of skill.allowedTools ?? []) {
    if (known.has(t)) allowed.push(t);
    else dropped.push(t);
  }
  return { allowed, dropped };
}

// ---------------------------------------------------------------------------
// runSkill(name) — prepare a skill's instructions for the next agent
// turn. The agent client appends the returned block to the system
// prompt before streaming. The skill never mutates the project; it
// only adds governance to the agent's behavior.
// ---------------------------------------------------------------------------

/**
 * Build the system-prompt block for activating a skill. Returns
 * `{ ok: true, block }` or `{ ok: false, reason }`. The block always
 * carries attribution, license, the effective allowedTools, and the
 * explicit governance text. Bundled skills and user skills are
 * treated identically; the loader decides trust.
 */
export function runSkill(name, options = {}) {
  const skill = getSkill(name);
  if (!skill) return { ok: false, reason: 'unknown skill: ' + String(name) };
  if (options.modelInvoked === true && !skill.modelInvocable) {
    return { ok: false, reason: 'skill is not model-invocable' };
  }
  if (options.userInvoked === true && !skill.userInvocable) {
    return { ok: false, reason: 'skill is not user-invocable' };
  }
  const { allowed, dropped } = intersectWithHost(skill);
  if (dropped.length > 0) {
    return { ok: false, reason: 'skill requested unknown tools: ' + dropped.join(', ') };
  }
  const block = [
    '--- skill: ' + skill.name + ' v' + skill.version + ' (' + skill.license + ') ---',
    skill.description,
    'effective allowed tools: [' + allowed.join(', ') + ']',
    skill.instructions,
    '--- end skill ---',
  ].join('\n');
  return { ok: true, block, allowedTools: allowed, skill };
}

export const _internals = { BUNDLED, skillSchema };
