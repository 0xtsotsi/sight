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
