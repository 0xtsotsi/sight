import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeAuditResults, cacheAuditResult } = require('./audit.js');
for (let i = 0; i < 10; i++) test(`audit normalization case ${i + 1}`, () => {
  const r = normalizeAuditResults({ passes: Array(i), violations: i ? [{ id: 'button-name', nodes: [{ target: [`button:nth-of-type(${i})`] }] }] : [] });
  assert.ok(Array.isArray(r.violations));
  assert.equal(typeof r.score, 'number');
});
test('cache stores normalized results', () => { const cache = new Map(); const out = cacheAuditResult(cache, 4, { violations: [] }); assert.equal(cache.get(4), out); });

test('empty audit results normalize cleanly', () => {
  const r = normalizeAuditResults({ violations: [], passes: [], incomplete: [], inapplicable: [] });
  assert.deepEqual(r.violations, []);
  assert.equal(r.passes, 0);
  assert.equal(r.incomplete, 0);
  assert.equal(r.score, 0);
  assert.equal(typeof r.timestamp, 'number');
});
test('handles multiple severities and a complex selector', () => {
  const r = normalizeAuditResults({
    passes: [{}],
    incomplete: [],
    violations: [
      { id: 'image-alt', impact: 'critical', help: 'Missing alt', nodes: [{ target: ['img.hero:nth-of-type(1)'] }] },
      { id: 'color-contrast', impact: 'serious', help: 'Low contrast', nodes: [{ target: ['p > span.link', 'p > span.link'] }] },
      { id: 'heading-order', impact: 'moderate', help: 'Skipped level', nodes: [{ target: ['h3'] }] },
    ],
  });
  assert.equal(r.violations.length, 3);
  assert.equal(r.violations[0].severity, 'critical');
  assert.equal(r.violations[1].severity, 'serious');
  assert.equal(r.violations[2].severity, 'moderate');
  // axe reports target as an array; we join them with a comma so the panel
  // can show a single, copy-pasteable selector.
  assert.equal(r.violations[1].selector, 'p > span.link, p > span.link');
  assert.equal(r.violations[0].targets[0].selector, 'img.hero:nth-of-type(1)');
  // Score = passes / (passes + violations + incomplete) * 100, rounded.
  assert.equal(r.score, 25);
});
test('selector variations: missing node, multiple targets, html fallback', () => {
  const r = normalizeAuditResults({
    violations: [
      { id: 'color-contrast', nodes: [{ target: [], html: '<span>x</span>' }] },
      { id: 'document-title', nodes: [{}] },
    ],
  });
  // No target at all → fall back to the element's html, then to 'document'.
  assert.equal(r.violations[0].selector, '<span>x</span>');
  assert.equal(r.violations[1].selector, 'document');
});
test('cache stores and overwrites by webContents id', () => {
  const cache = new Map();
  cacheAuditResult(cache, 1, { violations: [{ id: 'image-alt', nodes: [{ target: ['img'] }] }] });
  assert.equal(cache.get(1).violations.length, 1);
  // A subsequent audit overwrites the prior entry rather than appending.
  cacheAuditResult(cache, 1, { violations: [] });
  assert.equal(cache.get(1).violations.length, 0);
  // Different webContents ids are kept independent.
  cacheAuditResult(cache, 2, { violations: [{ id: 'link-name', nodes: [{ target: ['a'] }] }] });
  assert.equal(cache.get(1).violations.length, 0);
  assert.equal(cache.get(2).violations.length, 1);
});
