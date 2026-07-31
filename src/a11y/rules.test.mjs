import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_METADATA, getRuleMetadata, normalizeResults } from './rules.js';

for (const [id, rule] of Object.entries(RULE_METADATA)) {
  test(`${id} has complete metadata`, () => {
    assert.ok(['critical', 'serious', 'moderate', 'minor'].includes(rule.severity));
    assert.ok(rule.fixTemplate.length > 0);
    assert.equal(rule.selectorType, 'css');
    assert.match(rule.mdn, /^https:\/\//);
  });
}
test('unknown rules get a safe fallback', () => assert.equal(getRuleMetadata('no-such-rule').severity, 'minor'));
test('normalizes selectors and score', () => {
  const result = normalizeResults({ passes: [{}, {}], incomplete: [], violations: [{ id: 'image-alt', help: 'Missing alt', nodes: [{ target: ['img.hero'] }] }] });
  assert.equal(result.violations[0].selector, 'img.hero');
  assert.equal(result.violations[0].severity, 'critical');
  assert.equal(result.score, 67);
});
test('handles empty axe results', () => { const result = normalizeResults({}); assert.deepEqual(result.violations, []); assert.equal(result.passes, 0); assert.equal(result.incomplete, 0); assert.equal(result.score, 0); assert.equal(typeof result.timestamp, 'number'); });
