// scripts/screenshot-bright.mjs
//
// Captures the running /Applications/Brilliant.app for use as the bar
// reference in CorePrt's gauntlet-loop bar "brilliant-sight". Output
// goes to docs/screenshots/brilliant/ for A/B against sight's own
// screenshots at the same viewport.
//
// Usage:
//   node scripts/screenshot-bright.mjs                  # capture all visible windows at 1x
//   node scripts/screenshot-bright.mjs --scale 2        # @2x retina
//   node scripts/screenshot-bright.mjs --window 12345   # capture one window by id
//   node scripts/screenshot-bright.mjs --list           # list Brilliant windows without capturing
//
// Requires:
//   - macOS (uses `screencapture -l <wid>` — not portable to linux).
//   - /Applications/Brilliant.app installed.
//   - Accessibility + Screen Recording permission for the calling shell.
//   - Brilliant.app must be running (else no windows to capture).
//
// Output:
//   docs/screenshots/brilliant/<window-name>-<scale>x.png
//   docs/screenshots/brilliant/manifest.json
//
// Exit codes:
//   0  success (>=1 window captured)
//   1  uncaught error
//   2  /Applications/Brilliant.app not installed
//   3  no Brilliant windows found (launch the app first)
//   4  not on macOS

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs/screenshots/brilliant');
const APP_PATH = '/Applications/Brilliant.app';

function parseArgs(argv) {
  const out = { scale: 1, window: null, all: true, list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scale') out.scale = Number(argv[++i]);
    else if (a === '--window') {
      out.window = Number(argv[++i]);
      out.all = false;
    } else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/screenshot-bright.mjs [--scale N] [--window ID] [--list]'
      );
      process.exit(0);
    }
  }
  return out;
}

function isMacOS() {
  return process.platform === 'darwin';
}

async function listBrilliantWindows() {
  // AppleScript: ask System Events for every window of process "brilliant".
  // CFBundleName in /Applications/Brilliant.app/Contents/Info.plist is
  // "brilliant" (lowercase). Process names in `tell process` are matched
  // case-sensitively against the running process record, so the capital
  // "Brilliant" form silently returns {}.
  // Output shape: {{1234, "Home"}, {5678, "Chat"}, ...}
  const { stdout } = await exec('osascript', [
    '-e',
    'tell application "System Events" to tell process "brilliant" to get {id, name} of every window',
  ]);
  const pairs = [];
  const re = /\{\s*(\d+)\s*,\s*"([^"]*)"\s*\}/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    pairs.push({ id: Number(m[1]), name: m[2] || `window-${m[1]}` });
  }
  return pairs;
}

function safeName(name) {
  return name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'window';
}

async function captureWindow(wid, name, scale, outDir) {
  const file = `${safeName(name)}-${scale}x.png`;
  const outPath = path.join(outDir, file);
  const args = ['-l', String(wid), '-x', '-o', '-t', 'png'];
  if (scale !== 1) args.push('-r', String(scale));
  args.push(outPath);
  await exec('screencapture', args);
  return outPath;
}

async function main() {
  if (!isMacOS()) {
    console.error('screenshot-bright: macOS-only (uses screencapture -l <wid>)');
    process.exit(4);
  }
  if (!existsSync(APP_PATH)) {
    console.error(`screenshot-bright: ${APP_PATH} not installed`);
    process.exit(2);
  }

  const args = parseArgs(process.argv);
  await mkdir(OUT, { recursive: true });

  let targets;
  try {
    targets = await listBrilliantWindows();
  } catch (err) {
    console.error(
      `screenshot-bright: cannot list Brilliant windows: ${err.message}\n` +
        '  Grant Accessibility + Screen Recording to the calling shell, then launch Brilliant.app.'
    );
    process.exit(3);
  }

  if (args.list) {
    if (targets.length === 0) {
      console.error('screenshot-bright: --list, but no Brilliant windows. Launch /Applications/Brilliant.app first.');
      process.exit(3);
    }
    console.log(JSON.stringify(targets, null, 2));
    return;
  }

  if (targets.length === 0) {
    console.error('screenshot-bright: no Brilliant windows. Launch /Applications/Brilliant.app first.');
    process.exit(3);
  }

  if (!args.all && args.window !== null) {
    const found = targets.find((w) => w.id === args.window);
    if (!found) {
      console.error(
        `screenshot-bright: --window ${args.window} not in current Brilliant session.\n` +
          `  Known window ids: ${targets.map((w) => w.id).join(', ')}\n` +
          `  Re-run with --list to refresh.`
      );
      process.exit(3);
    }
    targets = [found];
  }

  const manifest = [];
  for (const t of targets) {
    try {
      const outPath = await captureWindow(t.id, t.name, args.scale, OUT);
      const rel = path.relative(ROOT, outPath);
      manifest.push({ id: t.id, name: t.name, scale: args.scale, path: rel });
      console.log(`captured ${t.name} (${t.id}) → ${rel}`);
    } catch (err) {
      console.error(`failed ${t.name} (${t.id}): ${err.message}`);
    }
  }

  if (manifest.length === 0) {
    console.error('screenshot-bright: every capture failed');
    process.exit(1);
  }

  const manifestPath = path.join(OUT, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        scale: args.scale,
        capturedAt: new Date().toISOString(),
        windows: manifest,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log(`\nmanifest → ${path.relative(ROOT, manifestPath)}`);
  console.log(`captured ${manifest.length}/${targets.length} windows`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});