const { normalizeResults } = require('../../src/a11y/rules.js');

function normalizeAuditResults(results) {
  return normalizeResults(results);
}

function cacheAuditResult(cache, webContentsId, results) {
  if (!cache || typeof cache.set !== 'function') throw new TypeError('An audit cache is required');
  const normalized = normalizeAuditResults(results);
  cache.set(webContentsId, normalized);
  return normalized;
}

module.exports = { normalizeAuditResults, cacheAuditResult };
