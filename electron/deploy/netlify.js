// Netlify CLI wrapper.
//
// `netlify deploy --dir=dist --prod` ships the static dist/ directory.
// Auth: NETLIFY_AUTH_TOKEN env var. parseOutput scans for the live URL,
// which Netlify prints as "Website URL: https://...".

function cliSpec({ projectPath, distPath, projectName, token, options = {} }) {
  if (!token) throw new Error('Netlify token is not set. Add one in Settings → Deploy.');
  const args = ['deploy', '--dir', distPath || 'dist'];
  if (options.production !== false) args.push('--prod');
  if (projectName) args.push('--site', projectName);
  if (options.message) args.push('--message', options.message);
  return {
    cmd: 'netlify',
    args,
    env: { NETLIFY_AUTH_TOKEN: token },
    cwd: projectPath,
    distPath: distPath || 'dist',
  };
}

// Netlify prints either:
//   "Website URL:      https://stunning-name-123abc.netlify.app" (prod), or
//   "Draft URL:        https://stunning-name-123abc.netlify.app" (preview)
// Both forms share the line shape — key, colon, then URL.
function parseOutput(stdout, stderr) {
  const text = (stdout || '') + (stderr || '');
  const prod = text.match(/Website URL[^\n]*?(https:\/\/[\w\-./?=&%]+)/i);
  if (prod) return { ok: true, url: prod[1], isProduction: true, message: 'Deployed to production.' };
  const draft = text.match(/Draft URL[^\n]*?(https:\/\/[\w\-./?=&%]+)/i);
  if (draft) return { ok: true, url: draft[1], isProduction: false, message: 'Preview deployed.' };
  return { ok: false, url: null, message: 'netlify CLI did not report a deployment URL.' };
}

function redact(text, token) {
  if (!text) return text;
  let out = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  if (!token) return out;
  if (token.length >= 6) {
    // Escape regex-special chars in the token, then allow optional
    // whitespace between every char — defeats soft-wrapping and
    // progress-bar fills where a CLI splatters the token across a line.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
    out = out.replace(new RegExp(escaped.split('').join('\\s*'), 'g'), '[redacted]');
  } else if (token.length >= 4) {
    // Medium-length tokens: literal match is safe enough.
    out = out.split(token).join('[redacted]');
  }
  // <4 chars: don't redact — too likely to clobber innocent text.
  return out;
}

module.exports = { cliSpec, parseOutput, redact, label: 'Netlify' };
