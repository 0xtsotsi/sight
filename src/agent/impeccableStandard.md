<!--
  Source: https://github.com/pbakaus/impeccable  (Apache-2.0)
  Version: 3.5.0
  Maintainer: pbakaus
  This is the Sight-adapted, abbreviated form of the Impeccable design standard.
  Sight never copies upstream text verbatim into the model prompt; it stores
  this file as a design-system source of truth, quotes short snippets, and
  always includes attribution + license.
-->

## Governing rules

1. The brief wins. Refine preserves; redesign replaces. Never blend the two.
2. Inspect the rendered output in bounded passes (desktop, tablet, mobile),
   not as a single overall pass.
3. Propose diffs; never write directly. The user is the final reviewer.
4. Use a separate-context reviewer for the final inspection so the builder
   does not grade its own work.
5. Keep product truth and design truth in durable project documents
   (`PRODUCT.md`, `DESIGN.md`).

## Surface intent

Classify every UI request into one intent before drafting:

- **Persuade** — landing pages, pricing, campaigns. Optimize for clarity,
  hierarchy, and one decisive action.
- **Operate** — dashboards, editors, settings. Optimize for density,
  predictability, and undo/redo.
- **Read** — docs, articles. Optimize for type, rhythm, and reference.
- **Experience** — immersive or editorial. Optimize for mood, motion, and
  narrative.

## Core workflows (use as a vocabulary, not as commands to the model)

- **Shape** — classify refine / extend / redesign and choose intent.
- **Audit** — mechanical checks: contrast, spacing, hierarchy, overflow,
  responsiveness, brief coverage.
- **Critique** — model-driven review of the rendered result against the brief.
- **Polish** — one grouped follow-up pass for mechanical + brief gaps.
- **Distill** — remove decorative elements that are not serving the intent.
- **Harden** — accessibility, focus, keyboard, and motion safety.
- **Adapt** — responsive and content-length variations.
- **Animate** — purposeful motion that supports the intent.
- **Typeset** — type scale, rhythm, and readability.
- **Layout** — grid, alignment, and rhythm.
- **Colorize** — palette restraint and emphasis.
- **Delight** — small, meaningful accents that are earned by the work.
- **Live** — separate-context finish review. Used once at the end of a
  workflow, never after every edit.

## Decision rule for visual direction

For new surfaces or true redesigns, present 2–4 visual direction cards. Each
card is a short prose description (≤ 80 words) of the visual direction plus
the kinds of components, type, and motion it would use. Do not pick the
final direction yourself — wait for the user to pin one, ask for variants,
or skip. Persist the chosen direction into `DESIGN.md` on Apply.

## Anti-patterns to flag in Audit

- Hard-coded type sizes or spacing that should come from a scale.
- Magic numbers in component instances that are not bound to a token.
- One-off colors not pulled from the palette.
- Buttons that are not actually clickable affordances (e.g. divs styled
  as buttons).
- Layouts that do not survive the next screen width or content length.
- Animations that do not support the surface intent.
- Content that is fabricated to fill space (testimonials, metrics, names).
- Decorative elements that distract from the surface intent.

## Out of scope for the standard

- Backend, server, or build pipeline changes.
- Tooling, lint, test, or CI configuration.
- Refactors that are not visible to the user.
- Security hardening not directly visible to the user.
