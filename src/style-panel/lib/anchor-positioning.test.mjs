// Round-trip + parse/emit tests for the CSS anchor-positioning helpers. Runs under
// `node --test` (no test framework dependency) — the panel UI does not depend on
// these functions being available at runtime, so testing in isolation is fine.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAnchorNames,
  emitAnchorNames,
  parsePositionAnchor,
  emitPositionAnchor,
  parseInsetArea,
  emitInsetArea,
  isDashedIdent,
  INSET_AREA_PRESETS,
  POPOVER_MODES,
  CLOSEDBY_MODES,
  usesAnchorSize,
} from './anchor-positioning.js'

// ── parseAnchorNames ──────────────────────────────────────────────────

test('parseAnchorNames: empty string defaults to the none keyword', () => {
  assert.deepEqual(parseAnchorNames(''), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parseAnchorNames('   '), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parseAnchorNames(null), { kind: 'keyword', value: 'none' })
})

test('parseAnchorNames: the keyword none is recognized case-insensitively', () => {
  assert.deepEqual(parseAnchorNames('none'), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parseAnchorNames('NONE'), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parseAnchorNames('Inherit'), { kind: 'keyword', value: 'inherit' })
})

test('parseAnchorNames: a single dashed-ident parses to a names list', () => {
  assert.deepEqual(parseAnchorNames('--button'), { kind: 'names', names: ['--button'] })
})

test('parseAnchorNames: a comma-separated list splits and trims', () => {
  assert.deepEqual(parseAnchorNames('--a, --b, --c'), { kind: 'names', names: ['--a', '--b', '--c'] })
  assert.deepEqual(parseAnchorNames('  --x  ,--y'), { kind: 'names', names: ['--x', '--y'] })
})

// ── emitAnchorNames ────────────────────────────────────────────────────

test('emitAnchorNames: keywords round-trip', () => {
  assert.equal(emitAnchorNames({ kind: 'keyword', value: 'none' }), 'none')
  assert.equal(emitAnchorNames({ kind: 'keyword', value: 'inherit' }), 'inherit')
})

test('emitAnchorNames: names list joins with comma+space', () => {
  assert.equal(emitAnchorNames({ kind: 'names', names: ['--a', '--b'] }), '--a, --b')
})

test('emitAnchorNames: empty input returns empty string', () => {
  assert.equal(emitAnchorNames(null), '')
  assert.equal(emitAnchorNames(undefined), '')
})

// ── parseAnchorNames + emitAnchorNames round-trip ──────────────────────

test('anchor-name round-trip: ident list', () => {
  const input = '--button, --icon'
  assert.equal(emitAnchorNames(parseAnchorNames(input)), input)
})

test('anchor-name round-trip: keyword', () => {
  assert.equal(emitAnchorNames(parseAnchorNames('none')), 'none')
})

// ── parsePositionAnchor ────────────────────────────────────────────────

test('parsePositionAnchor: empty + none + auto are keywords', () => {
  assert.deepEqual(parsePositionAnchor(''), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parsePositionAnchor('none'), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parsePositionAnchor('auto'), { kind: 'keyword', value: 'auto' })
})

test('parsePositionAnchor: a dashed-ident is parsed as an ident', () => {
  assert.deepEqual(parsePositionAnchor('--target'), { kind: 'ident', value: '--target' })
})

test('parsePositionAnchor: a bare word (no leading --) is preserved as raw', () => {
  // The panel never invalidates a value the user typed; we just surface it as-is.
  assert.deepEqual(parsePositionAnchor('something-else'), { kind: 'raw', value: 'something-else' })
})

// ── emitPositionAnchor ─────────────────────────────────────────────────

test('emitPositionAnchor: round-trips ident and keyword', () => {
  assert.equal(emitPositionAnchor({ kind: 'ident', value: '--target' }), '--target')
  assert.equal(emitPositionAnchor({ kind: 'keyword', value: 'auto' }), 'auto')
  assert.equal(emitPositionAnchor({ kind: 'raw', value: 'whatever' }), 'whatever')
})

// ── parseInsetArea ─────────────────────────────────────────────────────

test('parseInsetArea: single keyword', () => {
  assert.deepEqual(parseInsetArea('top'), { kind: 'keyword', value: 'top' })
  assert.deepEqual(parseInsetArea('center'), { kind: 'keyword', value: 'center' })
  assert.deepEqual(parseInsetArea('top-left'), { kind: 'keyword', value: 'top-left' })
})

test('parseInsetArea: two-area pair', () => {
  assert.deepEqual(parseInsetArea('top left'), { kind: 'pair', row: 'top', col: 'left' })
  assert.deepEqual(parseInsetArea('bottom right'), { kind: 'pair', row: 'bottom', col: 'right' })
})

test('parseInsetArea: none + empty', () => {
  assert.deepEqual(parseInsetArea('none'), { kind: 'keyword', value: 'none' })
  assert.deepEqual(parseInsetArea(''), { kind: 'keyword', value: 'none' })
})

test('parseInsetArea: unknown token is preserved as raw', () => {
  assert.deepEqual(parseInsetArea('made-up'), { kind: 'raw', value: 'made-up' })
})

// ── emitInsetArea ──────────────────────────────────────────────────────

test('emitInsetArea: pair joins with one space', () => {
  assert.equal(emitInsetArea({ kind: 'pair', row: 'top', col: 'left' }), 'top left')
})

test('emitInsetArea: keyword is passthrough', () => {
  assert.equal(emitInsetArea({ kind: 'keyword', value: 'center' }), 'center')
  assert.equal(emitInsetArea({ kind: 'keyword', value: 'none' }), 'none')
})

test('inset-area round-trip: pair and keyword', () => {
  assert.equal(emitInsetArea(parseInsetArea('top right')), 'top right')
  assert.equal(emitInsetArea(parseInsetArea('center')), 'center')
  assert.equal(emitInsetArea(parseInsetArea('span-all')), 'span-all')
})

// ── isDashedIdent ──────────────────────────────────────────────────────

test('isDashedIdent: valid dashed-ident names', () => {
  assert.equal(isDashedIdent('--button'), true)
  assert.equal(isDashedIdent('--a'), true)
  assert.equal(isDashedIdent('--my-anchor'), true)
  assert.equal(isDashedIdent('--_underscore'), true)
})

test('isDashedIdent: invalid (no leading double dash)', () => {
  assert.equal(isDashedIdent('button'), false)
  assert.equal(isDashedIdent('-button'), false)
  assert.equal(isDashedIdent(''), false)
})

// ── Preset lists ───────────────────────────────────────────────────────

test('INSET_AREA_PRESETS includes the four corners and center', () => {
  for (const p of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']) {
    assert.ok(INSET_AREA_PRESETS.includes(p), `expected ${p} in INSET_AREA_PRESETS`)
  }
})

test('POPOVER_MODES lists auto, manual, hint', () => {
  assert.deepEqual([...POPOVER_MODES], ['auto', 'manual', 'hint'])
})

test('CLOSEDBY_MODES lists none, any, closerequest, auto', () => {
  assert.deepEqual([...CLOSEDBY_MODES], ['none', 'any', 'closerequest', 'auto'])
})

// ── usesAnchorSize ─────────────────────────────────────────────────────

test('usesAnchorSize: detects anchor-size() in a value', () => {
  assert.equal(usesAnchorSize('anchor-size(width)'), true)
  assert.equal(usesAnchorSize('calc(anchor-size(height) / 2)'), true)
  assert.equal(usesAnchorSize('100%'), false)
  assert.equal(usesAnchorSize(''), false)
  assert.equal(usesAnchorSize(null), false)
})
