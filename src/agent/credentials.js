// src/agent/credentials.js
//
// Reads the user's gg settings file (~/.gg/settings.json) and exposes
// {provider, apiKey} for the agent panel.
//
// Task 3 ships a minimal read-only impl so the client can start. Task 7
// (credentials) will add the per-session cache, the panel banner wiring,
// and tests. Keep the function signature stable.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Recognized keys per provider. Order matters — first match wins.
const KEY_TABLE = [
  { provider: 'minimax', key: '[REDACTED]' },
  { provider: 'anthropic', key: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', key: 'OPENAI_API_KEY' },
  { provider: 'gemini', key: 'GEMINI_API_KEY' },
];

const SETTINGS_PATH = path.join(os.homedir(), '.gg', 'settings.json');

/**
 * Read ~/.gg/settings.json and return {provider, apiKey} for the first
 * recognized key. Returns null if the file is missing, unreadable, or has
 * no recognized provider configured.
 *
 * @returns {Promise<{provider: string, apiKey: string} | null>}
 */
export async function readCredential() {
  let raw;
  try {
    raw = await fs.readFile(SETTINGS_PATH, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  for (const { provider, key } of KEY_TABLE) {
    const value = parsed?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { provider, apiKey: value.trim() };
    }
  }
  return null;
}
