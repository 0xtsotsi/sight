// Manager — orchestrates build → deploy → parse, with injectable run/spawn
// so the test suite can mock the filesystem and process layer. Real callers
// (electron/main.js) inject `run` from this file and `spawn` from
// child_process.

const vercel = require('./vercel');
const netlify = require('./netlify');
const cloudflare = require('./cloudflare');

const PROVIDERS = {
  vercel: { ...vercel, defaultProjectName: (projectPath) => pathBasename(projectPath) },
  netlify: { ...netlify, defaultProjectName: (projectPath) => pathBasename(projectPath) },
  cloudflare: { ...cloudflare, defaultProjectName: (projectPath) => pathBasename(projectPath) },
};

function pathBasename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'sight-site';
}

function getAdapter(provider) {
  const a = PROVIDERS[provider];
  if (!a) throw new Error(`Unknown deploy provider: ${provider}. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  return a;
}

// Run `astro build` (the project's own script if present, else npx astro).
// Returns { ok, stdout, stderr, distPath }. We don't validate the dist
// directory exists here — caller can, the provider CLI will fail loudly if
// it's missing.
async function runBuild({ projectPath, run, onLog }) {
  if (typeof run !== 'function') throw new Error('runBuild requires an injected `run` function.');
  const started = Date.now();
  let res;
  try {
    res = await run('npm', ['run', 'build'], projectPath, { timeout: 600000 });
  } catch (err) {
    const stdout = err?.stdout?.toString() || '';
    const stderr = err?.stderr?.toString() || '';
    if (onLog) onLog({ kind: 'build', stdout, stderr, done: true, ok: false });
    return { ok: false, stdout, stderr, duration: Date.now() - started, error: err.message || String(err) };
  }
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (onLog) onLog({ kind: 'build', stdout, stderr, done: true, ok: true });
  return { ok: true, stdout, stderr, duration: Date.now() - started };
}

// Run the provider's CLI. The token is passed via env (set on the spawned
// process) — never as an argv element, so it never appears in process
// listings or shell history. Stdout/stderr are scrubbed by the adapter
// before being returned to the caller.
function runDeploy({ provider, projectPath, distPath, projectName, token, spawn, onLog }) {
  return new Promise((resolve, reject) => {
    const adapter = getAdapter(provider);
    const resolvedName = projectName || adapter.defaultProjectName(projectPath);
    let spec;
    try {
      spec = adapter.cliSpec({ projectPath, distPath, projectName: resolvedName, token });
    } catch (err) {
      reject(err);
      return;
    }
    if (typeof spawn !== 'function') {
      reject(new Error('runDeploy requires an injected `spawn` function.'));
      return;
    }
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onLog) onLog({ kind: 'deploy', provider, stream: 'stdout', text: adapter.redact(s, token) });
    });
    child.stderr?.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (onLog) onLog({ kind: 'deploy', provider, stream: 'stderr', text: adapter.redact(s, token) });
    });

    child.on('error', (err) => {
      reject(new Error(`Could not start ${spec.cmd}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      const redactedOut = adapter.redact(stdout, token);
      const redactedErr = adapter.redact(stderr, token);
      if (onLog) onLog({ kind: 'deploy', provider, stream: 'closed', code, signal });
      if (code !== 0) {
        const tail = (redactedErr || redactedOut).split('\n').filter(Boolean).slice(-8).join('\n');
        reject(new Error(`${adapter.label} exited with code ${code}${signal ? ` (signal ${signal})` : ''}.${tail ? `\n\n${tail}` : ''}`));
        return;
      }
      const parsed = adapter.parseOutput(redactedOut, redactedErr);
      if (!parsed.ok) {
        reject(new Error(parsed.message));
        return;
      }
      resolve({
        ok: true,
        provider,
        url: parsed.url,
        isProduction: parsed.isProduction,
        message: parsed.message,
        stdout: redactedOut,
        stderr: redactedErr,
      });
    });
  });
}

// End-to-end: build → deploy. Returns the same shape as runDeploy plus the
// build result. Rejects if either step fails.
async function runFullDeploy({
  projectPath,
  provider,
  projectName,
  token,
  distPath,
  run,
  spawn,
  onLog,
}) {
  if (!projectPath) throw new Error('projectPath is required.');
  if (!provider) throw new Error('provider is required.');
  const build = await runBuild({ projectPath, run, onLog });
  if (!build.ok) {
    const tail = (build.stderr || build.stdout || '').split('\n').filter(Boolean).slice(-10).join('\n');
    const err = new Error(`astro build failed.${tail ? `\n\n${tail}` : ''}`);
    err.build = build;
    throw err;
  }
  if (onLog) onLog({ kind: 'deploy', provider, stream: 'system', text: `Running ${provider} deploy…` });
  const result = await runDeploy({ provider, projectPath, distPath, projectName, token, spawn, onLog });
  return { ...result, build };
}

// For unit tests: assemble the same plan the manager would build without
// actually spawning anything. Each entry: { provider, ok, buildOnly, deploy? }.
function plan({ projectPath, provider, projectName, token, distPath, options }) {
  const adapter = getAdapter(provider);
  const resolvedName = projectName || adapter.defaultProjectName(projectPath);
  return {
    steps: [
      { name: 'build', tool: 'npm', args: ['run', 'build'], cwd: projectPath },
      {
        name: 'deploy',
        provider,
        spec: adapter.cliSpec({ projectPath, distPath, projectName: resolvedName, token, options }),
      },
    ],
  };
}

module.exports = {
  runBuild,
  runDeploy,
  runFullDeploy,
  plan,
  PROVIDERS,
  getAdapter,
};
