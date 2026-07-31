// IPC surface for the deploy feature.
//
// Tokens are stored encrypted at rest via Electron's safeStorage (Keychain on
// macOS, DPAPI on Windows, kwallet/gnome-libsecret on Linux). The renderer
// NEVER receives the token back — only `setToken` (write-only), `hasToken`
// (boolean), and `clearToken` are exposed. `deployStart` reads the token
// in-process, decrypts it, and passes it to the spawned provider CLI as an
// environment variable (never an argv element, so it can't appear in `ps`).
//
// All spawned output is funneled through `webContents.send('deploy:progress',
// …)` so the modal can stream build + deploy logs without polling.

const { spawn, execFile } = require('child_process');
const { runFullDeploy } = require('./manager');
const { detectCli } = require('./cli-detect');

// Map of provider -> encrypted Buffer (safeStorage output). Plaintext never
// touches disk; the map lives only in this process's heap.
const tokenStore = new Map();

// One CLI detection per process. The renderer can re-call `detectCli` cheaply,
// but the underlying shell-out is cached here so the user isn't paying for it
// every time they open the modal.
let cliCache = null;
let cliCacheAt = 0;
const CLI_CACHE_TTL_MS = 60_000;

function providerLabel(provider) {
  if (provider === 'vercel') return 'Vercel';
  if (provider === 'netlify') return 'Netlify';
  if (provider === 'cloudflare') return 'Cloudflare';
  return provider;
}

function getElectron() {
  return require('electron');
}

function safeAvailable() {
  try {
    return getElectron().safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function storeToken(provider, token) {
  if (!provider || !/^(vercel|netlify|cloudflare)$/.test(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Token is empty.');
  }
  const ss = getElectron().safeStorage;
  if (!ss.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available on this machine. Refusing to store the token in plaintext.');
  }
  tokenStore.set(provider, ss.encryptString(token.trim()));
}

function readToken(provider) {
  const enc = tokenStore.get(provider);
  if (!enc) return null;
  const ss = getElectron().safeStorage;
  try {
    return ss.decryptString(enc);
  } catch {
    // The encrypted blob is corrupt or the keyring changed — wipe it so the
    // user is prompted for a fresh token instead of getting a hard crash.
    tokenStore.delete(provider);
    return null;
  }
}

async function detectClis() {
  const now = Date.now();
  if (cliCache && now - cliCacheAt < CLI_CACHE_TTL_MS) return cliCache;
  const map = await detectCli();
  // Map the cli-detect keys (vercel / netlify / wrangler) to the providers
  // the renderer uses (vercel / netlify / cloudflare).
  cliCache = {
    vercel: !!map.vercel,
    netlify: !!map.netlify,
    cloudflare: !!map.wrangler,
  };
  cliCacheAt = now;
  return cliCache;
}

// Wraps child_process.spawn so the manager (which expects a spawn-like
// signature) can be called with the real thing.
function realSpawn(cmd, args, opts) {
  return spawn(cmd, args, opts);
}

// execFile with a timeout — the same shape as the project/git helper used
// elsewhere in main.js. Returns { stdout, stderr } on resolve, or throws an
// Error with `.stdout` / `.stderr` attached on non-zero exit.
function run(cmd, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: opts.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b/g, '');
}

function register(ipcMain) {
  ipcMain.handle('deploy:setToken', async (_e, { provider, token } = {}) => {
    storeToken(provider, token);
    return { ok: true, provider };
  });

  ipcMain.handle('deploy:hasToken', async (_e, { provider } = {}) => {
    return { ok: true, has: tokenStore.has(provider) };
  });

  ipcMain.handle('deploy:clearToken', async (_e, { provider } = {}) => {
    tokenStore.delete(provider);
    return { ok: true };
  });

  ipcMain.handle('deploy:detectCli', async () => {
    return detectClis();
  });

  ipcMain.handle('deploy:status', async () => {
    const cli = await detectClis();
    return {
      cli,
      hasToken: {
        vercel: tokenStore.has('vercel'),
        netlify: tokenStore.has('netlify'),
        cloudflare: tokenStore.has('cloudflare'),
      },
      safeStorageAvailable: safeAvailable(),
    };
  });

  // Run `npm run build` standalone so the modal can show build output before
  // it commits to a deploy. Strips ANSI; never returns the token.
  ipcMain.handle('deploy:build', async (e, { projectPath } = {}) => {
    if (!projectPath) throw new Error('projectPath is required.');
    const sender = e.sender;
    const started = Date.now();
    sender.send('deploy:progress', { kind: 'build', stream: 'started' });
    try {
      const res = await run('npm', ['run', 'build'], projectPath, { timeout: 600_000 });
      sender.send('deploy:progress', { kind: 'build', stream: 'stdout', text: stripAnsi(res.stdout || '') });
      sender.send('deploy:progress', { kind: 'build', stream: 'stderr', text: stripAnsi(res.stderr || '') });
      sender.send('deploy:progress', { kind: 'build', stream: 'closed', ok: true });
      return {
        ok: true,
        stdout: stripAnsi(res.stdout || ''),
        stderr: stripAnsi(res.stderr || ''),
        duration: Date.now() - started,
      };
    } catch (err) {
      const stdout = stripAnsi(err?.stdout?.toString?.() || '');
      const stderr = stripAnsi(err?.stderr?.toString?.() || '');
      sender.send('deploy:progress', { kind: 'build', stream: 'stdout', text: stdout });
      sender.send('deploy:progress', { kind: 'build', stream: 'stderr', text: stderr });
      sender.send('deploy:progress', { kind: 'build', stream: 'closed', ok: false });
      return {
        ok: false,
        stdout,
        stderr,
        duration: Date.now() - started,
        error: err?.message || String(err),
      };
    }
  });

  ipcMain.handle('deploy:start', async (e, { projectPath, provider, branch } = {}) => {
    if (!projectPath) throw new Error('projectPath is required.');
    if (!provider) throw new Error('provider is required.');
    const sender = e.sender;
    const token = readToken(provider);
    if (!token) {
      throw new Error(`${providerLabel(provider)} token is not set. Add one via Deploy → Settings.`);
    }
    if (!safeAvailable()) {
      throw new Error('OS keychain is unavailable; cannot run a deploy without decrypting a stored token.');
    }

    const started = Date.now();
    sender.send('deploy:progress', {
      kind: 'deploy',
      provider,
      stream: 'system',
      text: `Starting ${providerLabel(provider)} deploy from ${branch || 'current branch'}…`,
    });

    try {
      const result = await runFullDeploy({
        projectPath,
        provider,
        token,
        run,
        spawn: realSpawn,
        onLog: (entry) => {
          // Belt-and-braces: adapter already redacts, but if the deploy
          // phase leaks the token through some new CLI flag we'd rather
          // catch it here.
          if (entry.kind === 'deploy' && entry.text && token) {
            entry.text = entry.text.split(token).join('[redacted]');
          }
          sender.send('deploy:progress', entry);
        },
      });
      sender.send('deploy:progress', {
        kind: 'deploy',
        provider,
        stream: 'closed',
        ok: true,
        url: result.url,
        isProduction: result.isProduction,
      });
      return {
        ok: true,
        deployId: `${provider}-${Date.now()}`,
        url: result.url,
        isProduction: result.isProduction,
        message: result.message,
        duration: Date.now() - started,
      };
    } catch (err) {
      sender.send('deploy:progress', {
        kind: 'deploy',
        provider,
        stream: 'closed',
        ok: false,
        error: err?.message || String(err),
      });
      // Don't include the token in the error path either — the adapter
      // already redacts the tail, but scrub again just in case.
      const safe = String(err?.message || err).split(token).join('[redacted]');
      throw new Error(safe);
    }
  });
}

module.exports = {
  register,
  // Exported for unit tests so they can drive the same primitives.
  _internals: { storeToken, readToken, tokenStore, detectClis },
};
