// src/a11y/rules.js
//
// Pure data + tiny helpers. CommonJS module.exports (rather than ES
// `export`) so the Electron main process can require it through the
// a11y/audit.js bridge. The renderer uses the same module via Vite's
// ESM-to-ESM passthrough; both shapes coexist because Vite treats
// module.exports as the default export.

const RULES = {
  'image-alt': { severity: 'critical', fixTemplate: 'Add alt text to the image', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img' },
  'button-name': { severity: 'critical', fixTemplate: 'Add an accessible name to the button', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-label' },
  'link-name': { severity: 'serious', fixTemplate: 'Add an accessible name to the link', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a' },
  'label': { severity: 'critical', fixTemplate: 'Associate a label with the form control', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/label' },
  'color-contrast': { severity: 'serious', fixTemplate: 'Raise the text contrast', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Contrast' },
  'html-has-lang': { severity: 'serious', fixTemplate: 'Set the document language', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/lang' },
  'document-title': { severity: 'serious', fixTemplate: 'Add a descriptive page title', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/title' },
  'heading-order': { severity: 'moderate', fixTemplate: 'Fix the heading level order', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements' },
  'landmark-one-main': { severity: 'moderate', fixTemplate: 'Add a main landmark', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/main_role' },
  'region': { severity: 'moderate', fixTemplate: 'Place content inside a landmark', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/semantics' },
  'duplicate-id': { severity: 'serious', fixTemplate: 'Make the ID unique', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/id' },
  'aria-allowed-attr': { severity: 'critical', fixTemplate: 'Remove or correct the unsupported ARIA attribute', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes' },
  'aria-valid-attr-value': { severity: 'critical', fixTemplate: 'Correct the ARIA attribute value', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes' },
  'aria-roles': { severity: 'critical', fixTemplate: 'Use a valid ARIA role', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles' },
  'form-field-multiple-labels': { severity: 'moderate', fixTemplate: 'Keep one accessible label for the field', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/label' },
  'input-image-alt': { severity: 'critical', fixTemplate: 'Add alt text to the image input', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/image' },
  'meta-viewport': { severity: 'serious', fixTemplate: 'Allow zooming in the viewport', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag' },
  'nested-interactive': { severity: 'serious', fixTemplate: 'Remove the nested interactive control', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard' },
  'tabindex': { severity: 'serious', fixTemplate: 'Use a natural keyboard order', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/tabindex' },
  'table-header': { severity: 'serious', fixTemplate: 'Add a header to the table', selectorType: 'css', mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/th' },
};

const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];
const RULE_METADATA = Object.freeze(RULES);
const getRuleMetadata = (id) => RULES[id] || { severity: 'minor', fixTemplate: 'Review this accessibility issue', selectorType: 'css', mdn: 'https://www.w3.org/WAI/standards-guidelines/wcag/' };

function normalizeViolation(violation, index = 0) {
  const meta = getRuleMetadata(violation?.id);
  const targets = Array.isArray(violation?.nodes) ? violation.nodes : [];
  return {
    id: String(violation?.id || `unknown-${index}`),
    impact: violation?.impact || meta.severity,
    severity: meta.severity,
    description: String(violation?.help || violation?.description || 'Accessibility issue'),
    helpUrl: violation?.helpUrl || meta.mdn,
    fixTemplate: meta.fixTemplate,
    selector: targets[0]?.target?.join(', ') || targets[0]?.html || 'document',
    targets: targets.map((node) => ({ selector: node.target?.join(', ') || '', html: node.html || '', failureSummary: node.failureSummary || '' })),
  };
}

function normalizeResults(results = {}) {
  const violations = (results.violations || []).map(normalizeViolation);
  const passes = Array.isArray(results.passes) ? results.passes.length : 0;
  const incomplete = Array.isArray(results.incomplete) ? results.incomplete.length : 0;
  const score = Math.max(0, Math.min(100, Math.round((passes / Math.max(1, passes + violations.length + incomplete)) * 100)));
  return { violations, passes, incomplete, score, timestamp: results.timestamp || Date.now() };
}

module.exports = { SEVERITIES, RULE_METADATA, getRuleMetadata, normalizeViolation, normalizeResults };
// Vite ESM interop: also expose named exports for ESM consumers.
module.exports.SEVERITIES = SEVERITIES;
module.exports.RULE_METADATA = RULE_METADATA;
module.exports.getRuleMetadata = getRuleMetadata;
module.exports.normalizeViolation = normalizeViolation;
module.exports.normalizeResults = normalizeResults;