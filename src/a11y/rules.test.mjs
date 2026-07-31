import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_METADATA, getRuleMetadata, normalizeResults, normalizeViolation } from './rules.js';

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

test('rules with fix-templates carry a non-empty fixTemplate', () => {
  // Every catalogued rule ships a fixTemplate; the panel uses it as the
  // "Fix in canvas" tooltip and the click-to-fix toast copy.
  for (const [, rule] of Object.entries(RULE_METADATA)) {
    assert.ok(typeof rule.fixTemplate === 'string' && rule.fixTemplate.length > 0, `rule missing fixTemplate: ${rule.fixTemplate}`);
  }
});
test('specific rules map to expected MDN URLs', () => {
  // Regression: keep the MDN links pointed at the primary MDN page for the
  // affected element / attribute — a wrong link returns a 404 from MDN.
  assert.equal(RULE_METADATA['image-alt'].mdn, 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img');
  assert.equal(RULE_METADATA['color-contrast'].mdn, 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Contrast');
  assert.equal(RULE_METADATA['button-name'].mdn, 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-label');
  assert.equal(RULE_METADATA['label'].mdn, 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/label');
});
test('getRuleMetadata returns a safe fallback for unknown ids', () => {
  const m = getRuleMetadata('no-such-rule-xyz');
  assert.equal(m.severity, 'minor');
  assert.equal(typeof m.fixTemplate, 'string');
  assert.ok(m.fixTemplate.length > 0);
  assert.equal(m.selectorType, 'css');
  assert.match(m.mdn, /^https:\/\//);
});
test('normalizeViolation preserves impact and augments with severity', () => {
  // axe reports `impact`; we keep it (so the panel can color bars by impact)
  // and add `severity` from our rule map (the canonical grading).
  const v = normalizeViolation({ id: 'link-name', impact: 'minor', help: 'Link text', nodes: [{ target: ['a'] }] }, 0);
  assert.equal(v.id, 'link-name');
  assert.equal(v.impact, 'minor');
  assert.equal(v.severity, 'serious'); // catalogued severity wins
  assert.equal(v.selector, 'a');
  assert.equal(v.fixTemplate, RULE_METADATA['link-name'].fixTemplate);
});
