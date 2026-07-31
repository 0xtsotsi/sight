// Vercel CLI wrapper.
//
// vercel deploy --prebuilt --archive=tgz reuses the .vercel/output produced
// by `astro build` (Astro's @astrojs/vercel adapter writes there). The token
// is passed via VERCEL_TOKEN env var rather than --token so it never lands
// in the process list or shell history. parseOutput pulls the deployment URL
// out of stdout and falls back to stderr if vercel printed it there.

function cliSpec({ projectPath, distPath, projectName, token, options = {} }) {
  if (!token) throw new Error('Vercel token is not set. Add one in Settings → Deploy.');
  const args = ['deploy', '--prebuilt', '--archive=tgz', '--yes'];
  if (projectName) args.push('--name', projectName);
  if (options.production === false) args.push('--no-prod');
  if (options.alias) args.push('--target', options.alias);
  // `--archive=tgz` ignores the cwd's distPath argument and reads from
  // .vercel/output. Pass it anyway in case the user pointed --local at
  // somewhere else (a future-proofing escape hatch).
  return {
    cmd: 'vercel',
    args,
    env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: '', VERCEL_PROJECT_ID: '' },
    cwd: projectPath,
    distPath: distPath || '.vercel/output',
  };
}

// Production URLs land on <project>.vercel.app; previews on
// <project>-git-<branch>-<user>.vercel.app. Vercel prints the canonical
// line "Production: https://..." or "Preview: https://..." on stdout.
function parseOutput(stdout, stderr) {
  const text = (stdout || '') + (stderr || '');
  const m = text.match(/(?:Production|Preview|Deployment URL):\s*(https:\/\/[\w\-./?=&%]+)/i);
  if (!m) return { ok: false, url: null, message: 'vercel CLI did not report a deployment URL.' };
  const url = m[1].trim().split(/\s+/)[0];
  const isProd = /Production/i.test(m[0]);
  return { ok: true, url, isProduction: isProd, message: isProd ? 'Deployed to production.' : 'Preview deployed.' };
}

// Strip ANSI escapes plus any line that happens to contain the token. This
// is a belt-and-braces pass: the token is in env, not argv, but vercel could
// echo $VERCEL_TOKEN somewhere (e.g. when verbose). Better to scrub than to
// discover a leak in production.
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

module.exports = { cliSpec, parseOutput, redact, label: 'Vercel' };
