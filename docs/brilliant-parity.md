# Sight ↔ Brilliant — Feature Parity Plan

**Reference app:** `/Applications/Brilliant.app` (Brilliant 0.1.0-beta.49).
**Source-of-truth feature map:** `.gg/plans/brilliant-but-better.md` (the M0–M11 milestone doc — keep this in sync if any PR changes scope).

This document slices the Brilliant parity work into **7 sequential PRs**, each with its own branch, worktree, and quality gate. After every PR: `npm test` green, `npm run build` green, `npm run dev` smoke, A/B screencapture wins blind against `/Applications/Brilliant.app`, your own `/review` and `/ship`, then PR opened, merge only when green.

---

## Gates (every PR)

1. `npm test` — all tests pass (exit 0). Foundation starts at 57/57.
2. `npm run build` — exit 0, `dist/index.html` exists, ≥1 `.js` + ≥1 `.css` in `dist/assets/`.
3. `npm run dev` smoke — launch app, confirm AgentPanel renders, no console errors.
4. `node scripts/screenshot-bright.mjs` — capture Brilliant reference windows (requires `/Applications/Brilliant.app` running).
5. Capture matching sight window via Playwright/Electron; render both at the same viewport with labels stripped; **ours must win blind**.
6. Own `/review` critique — the gauntlet critic on the new feature, recorded as a comment in the PR.
7. Own `/ship` — release notes + screenshot committed under `docs/screenshots/`.
8. PR opened. **Merge only if all of the above are green.**

---

## Branch + worktree convention

Every PR lives in a sibling git worktree at `~/Documents/projects/sight.worktrees/feat/<name>/`, branched off `origin/main` (not local main).

```bash
cd ~/Documents/projects/sight
git fetch origin main
git worktree add -b feat/<name> ~/Documents/projects/sight.worktrees/feat/<name> origin/main
cd ~/Documents/projects/sight.worktrees/feat/<name>
npm ci --legacy-peer-deps
```

If the worktree already exists for the branch, `cd` into it and `git pull --ff-only`. Don't branch from a feature branch — always from `origin/main`.

---

## PRs

### PR 1 — Foundation ✅ this PR

**Scope:** meta only. New bar in CorePrt's gauntlet registry (`agents/_lib/skills/gauntlet-loop/bars/brilliant-sight.json`), the `screenshot-bright.mjs` helper, this plan file, and the 7-PR slicing of `brilliant-but-better.md`. **No feature code.**

Files touched:
- `scripts/screenshot-bright.mjs` (new) — `screencapture -l <wid>` A/B helper.
- `docs/brilliant-parity.md` (new) — this file.
- Cross-repo: `0xtsotsi/coreprt` `agents/_lib/skills/gauntlet-loop/bars/brilliant-sight.json` (separate PR on the CorePrt repo).

Verification gates:
- `npm test` green (57/57).
- `npm run build` green.
- `node scripts/screenshot-bright.mjs` runs and writes `docs/screenshots/brilliant/manifest.json` (requires `/Applications/Brilliant.app` running).

---

### PR 2 — Chrome

**Scope:** Brilliant's menubar, right inspector, left rail, bottom toolbar — the chrome layer that wraps the canvas and the agent panel.

Maps from `brilliant-but-better.md`:
- **M3 (regions)** — left/right/bottom/full snap regions for the side panels and the agent panel.
- **M4 (visual polish)** — bubble styles, ThinkingBlock, tool cards, TypingDots (the parts that live in chrome, not in the composer).

Files touched (estimated):
- `src/App.jsx` — menubar / rail / inspector / toolbar shell.
- `src/ui/MenuBar.jsx` (new) — top menubar.
- `src/ui/LeftRail.jsx` (new), `src/ui/RightInspector.jsx` (new), `src/ui/BottomToolbar.jsx` (new).
- `src/panels/AgentPanel.jsx` — region variants.

Verification:
- All 8 gates above.
- A/B vs Brilliant's menubar/rail/inspector at 1440×900 (and 390×844 mobile), labels stripped.

---

### PR 3 — Command Palette + Shortcuts + Insert Search

**Scope:** ⌘K command palette, the keyboard-shortcuts overlay Brilliant shows under Help, the Insert Search panel (effects / presets / blocks).

Maps from `brilliant-but-better.md`:
- **M2 (slash menu)** — the slash-menu surface is lifted into the palette as a sub-mode.
- **New** — `src/ui/CommandPalette.jsx` (palette shell, fuzzy search, ⌘K binding, ⌘ / binding).
- **New** — `src/ui/KeyboardShortcuts.jsx` (the Help → Keyboard Shortcuts panel).

Files touched (estimated):
- `src/ui/CommandPalette.jsx` (new).
- `src/ui/InsertSearch.jsx` (new — slash-menu surface + extend).
- `src/ui/KeyboardShortcuts.jsx` (new).
- `src/App.jsx` — ⌘K binding.

---

### PR 4 — Agent UI

**Scope:** multi-chat, slash commands, @-mentions, replays, diff cards, model picker, history — the heart of the in-panel agent experience.

Maps from `brilliant-but-better.md`:
- **M1 (virtualized list)** — `@tanstack/react-virtual` for the message list (only here).
- **M2 (composer)** — slash menu (now lives in the palette from PR 3 but the composer-side trigger stays), `@`-mentions, attachment chips, model picker, prompt history (↑↓), ⌃R reverse-search, draft preservation.
- **M4 (visual polish)** — ThinkingBlock with live `mm:ss` timer, tool cards with copy-JSON, send-icon morph, TypingDots, hover-reveal timestamps.
- **M5 (hygiene)** — drop stale image attachments, collapse large tool results, compact adjacent tool updates.
- **M6 (parallel chats)** — lift chats to App, chat list, ⌘1–⌘9, ⌘⇧I cross-chat search, per-chat undo/redo.
- **M7 (parallel agents)** — surface `open_background_task` / `finalize_background_task` as parallel-agent lanes; extract `DiffCard.jsx` with `streamId` + conflict badge.

Files touched (estimated):
- `src/panels/AgentPanel.jsx`, `src/panels/PromptHistory.jsx`, `src/panels/ChatList.jsx`, `src/panels/ChatKeymap.js`, `src/panels/CrossChatSearch.jsx`, `src/panels/DiffCard.jsx`, `src/panels/hygiene.js`.
- `src/agent/tools-orchestrator.js`, `src/agent/systemPrompt.js`.

---

### PR 5 — Design Tools

**Scope:** Figma import, multi-format export, design tokens, density modes, transitions library, drops (frame export), per-project version history (snapshots).

Maps from `brilliant-but-better.md`:
- **M8 (design systems)** — `.sight/design-systems.json`, per-frame `data-design-system` switch, token emit, StylePanel dropdown, agent prompt awareness.
- **M9 (drops)** — `frame:export` IPC, "Share selected frame as Drop" toolbar button, ZIP output.
- **M10 (presets)** — 5 glass + 5 fill CSS presets, Effects group in InsertSearch, agent prompt extension.
- **M11 (history)** — `project:snapshot` IPC (tarball), idle + manual + commit triggers, restore UI, snapshot-to-now diff viewer, 20 + 7 daily rotation.
- **New** — Figma `.fig` import (parse → node tree), density modes (compact / comfortable / spacious), transitions library.

Files touched (estimated):
- `electron/main.js` — Figma-import IPC, frame-export, snapshot IPCs.
- `electron/astroParser.js` — token emit (M8).
- `electron/cmsRefs.js` — Figma path.
- `src/panels/StylePanel.jsx`, `src/ui/InsertSearch.jsx` (Effects group).
- `src/styles/presets/index.css` (new).
- `src/panels/SnapshotViewer.jsx` (new).

This is the largest PR — consider slicing into **PR 5a** (drops + snapshots) and **PR 5b** (Figma + tokens + density + transitions + presets) if its diff exceeds ~1500 LOC.

---

### PR 6 — Multiplayer

**Scope:** Yjs presence, comments, share, activity feed.

Not in `brilliant-but-better.md` (that doc was single-player scope). All new.

Files touched (estimated):
- `src/collab/yjs-doc.js` (new), `src/collab/provider.js` (new).
- `electron/main.js` — collab IPC bridge.
- `src/panels/Comments.jsx` (new), `src/panels/ActivityFeed.jsx` (new), `src/ui/ShareDialog.jsx` (new).

Verification:
- All 8 gates above.
- Two-process A/B: open sight twice, confirm presence cursors + comments sync within 200 ms.

---

### PR 7 — Polish + Ship

**Scope:** visual pass across PRs 2–6, animation consistency, accessibility audit, final blind A/B against `/Applications/Brilliant.app`, release notes, screenshot gallery, public release tag.

Files touched: all surfaces; mostly `*.module.css` and copy.

Verification:
- All 8 gates above.
- Final blind A/B at all four viewports (1440×900, 1280×800, 768×1024, 390×844) — ours wins blind on every one.
- Tagged release via `./release.sh`.

---

## Invariants (from `sight/CLAUDE.md`)

These MUST NOT break across any PR:

- `apply_page_diff` stays the only mutation entry; no agent tool calls any `avb.*` write verb directly (`src/agent/tools.js:7-8`).
- Approval policy in `src/agent/policy.js:102-127` is fixed. New tools go in `TOOL_MANIFEST`.
- `electron/astroParser.js` stays in `build.asarUnpack` (`package.json:66-68`).
- `build.appId` stays `dev.flowtricks.sight` even though `build.publish.owner` is `0xtsotsi`.
- `STYLE_NUDGE_MS = 150` preserved (`electron/main.js`).
- `markSelfWrite` 1s write-suppression window preserved (`electron/main.js:1335-1380`).
- Provider picker: only `anthropic`, `openai`, `gemini`, `claudeCode`. No OpenRouter, no others.
- TanStack `@tanstack/react-virtual`: **only** in `AgentPanel.jsx` message list. Other lists (chat list, snapshot list) intentionally un-virtualized.
- macOS entitlements: `disable-library-validation: true` preserved (`resources/*.plist`).
- `npm ci` requires `--legacy-peer-deps` (openai/zod peer-conflict in lockfile).
- Two remotes: `origin` = `0xtsotsi/sight` (push), `upstream` = `flowtricks/stacki` (`pushurl = no_push`). `.githooks/pre-push` is NOT auto-installed — run `git config core.hooksPath .githooks` once.

## Decisions (locked, per `brilliant-but-better.md`)

1. No OpenRouter — provider picker lists `anthropic`, `openai`, `gemini`, `claudeCode` only.
2. No web playground.
3. No new transport — existing Nostr/MCP stack stays.
4. gg-coder (`runAgentStream`) is the only agent runtime.
5. Snapshot storage: tarball (`.sight/snapshots/<ts>.tar.gz`).
6. Parallel-agent conflict policy: force user to pick (no auto-rebase).

## Risks

- **Cross-repo PRs (PR 1):** the bar lives in `0xtsotsi/coreprt`, not in sight. Foundation opens two PRs with the same branch name; link them via PR descriptions.
- **`docs/` is gitignored** (`sight/.gitignore:17`). This plan file is force-tracked via `git add -f`. Follow-up cleanup: refine the `.gitignore` so `docs/*.md` and `docs/screenshots/*.png` are tracked while the rest of `docs/` stays ignored.
- **A/B windows differ across Brilliant versions.** Brilliant 0.1.0-beta.49 is the captured bar. A new Brilliant release changes the comparison.
- **`screencapture -l <wid>` is macOS-only** (`screencapture -l` doesn't exist on linux). CI on linux will skip the A/B step and report "no reference".
- **TanStack scope creep** — if any PR adds TanStack outside the message list, reject in review.
- **Bundle growth from PR 5 presets** — ≤10 KB CSS cap per M10.

## Source

Adapted from `.gg/plans/brilliant-but-better.md` (the source-of-truth M0–M11 milestone doc). This document slices the same work into 7 PRs with explicit per-PR gates and the bar/quality infra in CorePrt.