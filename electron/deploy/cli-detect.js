// CLI detection — `which vercel / which netlify / which wrangler`, with the
// result cached for the lifetime of the process. The renderer asks once at
// app start, and the SettingsDeploy tab falls back to "missing" copy when a
// provider's binary isn't on PATH. Token strings must never be in here.

const { execFile } = require('child_process');

const PROVIDERS = ['vercel', 'netlify', 'wrangler'];

// On Windows each binary has a `.cmd`/`.ps1` shim; which.js resolves them
// through PATHEXT. sh -c "command -v <name>" is the portable equivalent — it
// uses the login shell's PATH, which (unlike process.env.PATH at GUI launch)
// includes Homebrew, fnm, nvm, and volta bins.
const SCRIPT = (process.platform === 'win32')
  ? `for (const p of [%PROVIDERS%]) { try { where /q $p && echo ON:$p || echo OFF:$p } catch { echo OFF:$p } }`
  : `for (p in %LIST%); do command -v "$p" >/dev/null 2>&1 && echo ON:$p || echo OFF:$p; done`;

function buildScript(providers) {
  return SCRIPT.replace('%PROVIDERS%', providers.map((p) => `"${p}"`).join(','))
               .replace('%LIST%', providers.join(' '));
}

// Single shell-out per call. Cheaper than one spawn per provider when we cache
// the result for the rest of the session.
function detectCli({ shell = '/bin/sh', providers = PROVIDERS, exec = execFile } = {}) {
  const script = buildScript(providers);
  return new Promise((resolve) => {
    exec(shell, ['-c', script], { timeout: 5000 }, (err, stdout) => {
      const out = (stdout || '').toString();
      const map = Object.fromEntries(providers.map((p) => [p, false]));
      if (err) return resolve(map);
      for (const line of out.split(/\r?\n/)) {
        const m = /^ON:(\S+)/.exec(line);
        if (m && Object.prototype.hasOwnProperty.call(map, m[1])) map[m[1]] = true;
      }
      resolve(map);
    });
  });
}

// Synchronous flavor for the test suite — uses an injected execSync-like
// function so we can mock it without monkey-patching child_process.
function detectCliSync({ providers = PROVIDERS, execSync }) {
  const map = Object.fromEntries(providers.map((p) => [p, false]));
  if (!execSync) return map;
  for (const p of providers) {
    try {
      const r = execSync(p, ['--version'], { stdio: 'ignore', timeout: 3000 });
      // Some CLIs (wrangler, netlify) print version banners; just confirm the
      // call resolved without throwing.
      if (r !== undefined) map[p] = true;
    } catch {
      map[p] = false;
    }
  }
  return map;
}

module.exports = { detectCli, detectCliSync, PROVIDERS };
