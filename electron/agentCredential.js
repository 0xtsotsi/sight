// electron/agentCredential.js
//
// Shared credential-lookup logic for the agent side-panel IPC.
//
// Used by:
//   - electron/main.js (the `agent:getCredential` IPC handler)
//   - tests/scripts that want to verify the same lookup path
//
// Kept CommonJS so it can be `require()`d from main.js without touching the
// Vite-built renderer bundle. The renderer never imports this file directly
// — it only sees the IPC response shape.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const CREDENTIAL_TABLE = [
  { provider: 'minimax', settingsKey: 'MINIMAX_API_KEY', authKey: 'minimax' },
  { provider: 'anthropic', settingsKey: 'ANTHROPIC_API_KEY', authKey: 'anthropic' },
  { provider: 'openai', settingsKey: 'OPENAI_API_KEY', authKey: 'openai' },
  { provider: 'gemini', settingsKey: 'GEMINI_API_KEY', authKey: 'gemini' },
];

const HOME_PATHS = {
  settings: path.join(os.homedir(), '.gg', 'settings.json'),
  auth: path.join(os.homedir(), '.gg', 'auth.json'),
};

/**
 * Read `~/.gg/settings.json` (or `~/.gg/auth.json`). Returns
 * `{ json, error }` — either `json` is set or `error` is a string. Never
 * throws. Path traversal is sandboxed to $HOME.
 */
function readHomeFileSafe(filename) {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(home, filename);
  if (!resolved.startsWith(home + path.sep)) {
    return { error: filename + ' escaped home' };
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return { json: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: 'not found' };
    return { error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Pick the first recognized provider's credential. Priority:
 *   1. ~/.gg/settings.json (user-supplied override wins)
 *   2. ~/.gg/auth.json    (the `ggcoder login` store)
 *
 * Returns `{ provider, apiKey }` or `null`. Trims whitespace.
 */
function pickCredential(settingsJson, authJson, table = CREDENTIAL_TABLE) {
  if (settingsJson && typeof settingsJson === 'object') {
    for (const row of table) {
      const v = settingsJson[row.settingsKey];
      if (typeof v === 'string' && v.trim().length > 0) {
        return { provider: row.provider, apiKey: v.trim() };
      }
    }
  }
  if (authJson && typeof authJson === 'object') {
    for (const row of table) {
      const entry = authJson[row.authKey];
      const v = entry && entry.accessToken;
      if (typeof v === 'string' && v.trim().length > 0) {
        return { provider: row.provider, apiKey: v.trim() };
      }
    }
  }
  return null;
}

/**
 * The IPC handler body. Reads the two home files and returns the wire
 * shape the renderer expects: `{ ok: true, credential: { provider, apiKey } }`
 * or `{ ok: false, error: string }`.
 */
function getCredential() {
  try {
    const settings = readHomeFileSafe('.gg/settings.json');
    const auth = readHomeFileSafe('.gg/auth.json');
    const picked = pickCredential(settings.json, auth.json);
    if (!picked) {
      return {
        ok: false,
        error:
          'no recognized provider key. Set MINIMAX_API_KEY in ~/.gg/settings.json ' +
          'or run `ggcoder login` (writes ~/.gg/auth.json).',
      };
    }
    return { ok: true, credential: picked };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  CREDENTIAL_TABLE,
  HOME_PATHS,
  readHomeFileSafe,
  pickCredential,
  getCredential,
};
