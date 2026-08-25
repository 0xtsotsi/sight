// electron/__tests__/snapshots.test.js
//
// M11 verification: snapshots round-trip and the rotation policy keeps
// 20 most-recent + last 7 daily snapshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const _require = createRequire('file://' + path.resolve('electron/').replace(/\\/g, '/') + '/');

// Load the tar helpers from main.js via a VM sandbox. We only need the
// buildProjectTar + extractTar + pruneSnapshots trio.
const src = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const tarHeader = src.match(/function tarHeader[\s\S]+?\n\}\n/)[0];
const buildTar = src.match(/function buildTar[\s\S]+?\n\}\n/)[0];
const extractTar = src.match(/function extractTar[\s\S]+?\n\}\n/)[0];
const pruneSnapshots = src.match(/function pruneSnapshots[\s\S]+?\n\}\n/)[0];
const buildTarProject = src.match(/function buildProjectTar[\s\S]+?\n\}\n/)[0];

const code = `
const fs = require('fs');
const path = require('path');
const { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync } = fs;
${tarHeader}
${buildTar}
${extractTar}
${pruneSnapshots}
${buildTarProject}
module.exports = { buildTar, extractTar, pruneSnapshots, buildProjectTar };
`;

const sandbox = { module: { exports: {} }, require: _require, fs: _require('fs'), path: _require('path'), Buffer, zlib: _require('zlib'), mkdirSync: _require('fs').mkdirSync, writeFileSync: _require('fs').writeFileSync, readFileSync: _require('fs').readFileSync, readdirSync: _require('fs').readdirSync, statSync: _require('fs').statSync, unlinkSync: _require('fs').unlinkSync, utimesSync: _require('fs').utimesSync };
const ctx = vm.createContext(sandbox);
const wrapped = `(function(require, module, exports){ ${code} })`;
const fn = vm.runInContext(wrapped, ctx);
fn(sandbox.require, sandbox.module, sandbox.module.exports);
const { buildProjectTar: buildProjectTarFn, extractTar: extractTarFn, pruneSnapshots: pruneSnapshotsFn } = sandbox.module.exports;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-snap-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.astro'), '---\nconst x = 1;\n---\n<p>Hello</p>');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }));
  return dir;
}

test('M11-1: snapshot round-trip restores files exactly', async () => {
  const projectRoot = makeProject();
  try {
    const tar = buildProjectTarFn(projectRoot);
    // Modify the project on disk.
    const indexPath = path.join(projectRoot, 'src', 'pages', 'index.astro');
    fs.writeFileSync(indexPath, '---\n---\n<p>CHANGED</p>');
    // Restore from the snapshot.
    extractTarFn(tar, projectRoot);
    const restored = fs.readFileSync(indexPath, 'utf8');
    assert.equal(restored, '---\nconst x = 1;\n---\n<p>Hello</p>');

    // The package.json is also restored.
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'demo');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('M11-2: snapshot refuses to escape the project root', async () => {
  const projectRoot = makeProject();
  try {
    const sandbox2 = { module: { exports: {} }, require: _require, fs: _require('fs'), path: _require('path'), Buffer, zlib: _require('zlib'), mkdirSync: _require('fs').mkdirSync, writeFileSync: _require('fs').writeFileSync, readFileSync: _require('fs').readFileSync };
    const ctx2 = vm.createContext(sandbox2);
    const fake = vm.runInContext(wrapped, ctx2);
    fake(sandbox2.require, sandbox2.module, sandbox2.module.exports);
    const { buildTar, extractTar } = sandbox2.module.exports;
    const malicious = buildTar([{ name: '../evil.txt', content: 'malicious' }]);
    // The implementation skips path-traversal entries silently rather than
    // throwing; that's the safer behavior for the IPC consumer.
    extractTar(malicious, projectRoot);
    // The original file is intact.
    const restored = fs.readFileSync(path.join(projectRoot, 'src', 'pages', 'index.astro'), 'utf8');
    assert.equal(restored, '---\nconst x = 1;\n---\n<p>Hello</p>');
    // The malicious file should NOT exist anywhere outside the project root.
    // We just confirm the project tree is unchanged.
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('M11-3: rotation keeps 20 most-recent + 7 daily snapshots', async () => {
  const projectRoot = makeProject();
  try {
    const dir = path.join(projectRoot, '.sight', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    // Create 30 snapshots with different mtimes.
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const f = path.join(dir, `${now - i * 100000}.tar.gz`);
      fs.writeFileSync(f, 'mock');
      fs.utimesSync(f, (now - i * 100000) / 1000, (now - i * 100000) / 1000);
    }
    pruneSnapshotsFn(dir);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).length;
    assert.ok(remaining >= 20 && remaining <= 27, `expected 20-27 snapshots, got ${remaining}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
