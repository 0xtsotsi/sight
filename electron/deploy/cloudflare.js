// Cloudflare Pages wrapper (wrangler).
//
// `wrangler pages deploy dist --project-name=<name>` ships to a Pages
// project. Auth: CLOUDFLARE_API_TOKEN env var. parseOutput pulls the
// `https://<hash>.<project>.pages.dev` URL from stdout.

function todayISO() {
  // `compatibility-date` must be ISO YYYY-MM-DD; older wrangler versions
  // required a flag, newer make it implicit. Pass it explicitly so a stale
  // local wrangler doesn't reject the deploy.
  return new Date().toISOString().slice(0, 10);
}

function cliSpec({ projectPath, distPath, projectName, token, options = {} }) {
  if (!token) throw new Error('Cloudflare token is not set. Add one in Settings → Deploy.');
  const name = projectName || options.defaultName || 'sight-site';
  const args = [
    'pages', 'deploy', distPath || 'dist',
    '--project-name', name,
    '--compatibility-date', todayISO(),
  ];
  if (options.environment) args.push('--env', options.environment);
  if (options.branch) args.push('--branch', options.branch);
  return {
    cmd: 'wrangler',
    args,
    env: { CLOUDFLARE_API_TOKEN: token },
    cwd: projectPath,
    distPath: distPath || 'dist',
  };
}

// Wrangler prints "Deployment complete! (X.XXs)" then a URL on the next line:
//   View at: https://abc123.sight-site.pages.dev
function parseOutput(stdout, stderr) {
  const text = (stdout || '') + (stderr || '');
  const m = text.match(/(?:View at|Deployed to):\s*(https:\/\/[\w\-./?=&%]+pages\.dev[\w\-./?=&%]*)/i);
  if (!m) return { ok: false, url: null, message: 'wrangler did not report a deployment URL.' };
  return { ok: true, url: m[1], isProduction: true, message: 'Deployed to Cloudflare Pages.' };
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

module.exports = { cliSpec, parseOutput, redact, label: 'Cloudflare Pages' };
