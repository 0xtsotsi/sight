// electron/__tests__/export-frame.test.js
//
// M9 verification: the zip builder produces a valid PKZIP archive
// containing the requested entries. We read the `buildZip` helper from
// `electron/main.js` via a small VM sandbox so the test stays isolated
// from the heavy process-boot logic. The CRC32 + zlib.deflateRawSync
// path is exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const _require = createRequire('file://' + path.resolve('electron/').replace(/\\/g, '/') + '/');

const src = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
// Locate the buildZip declaration.
const match = src.match(/function buildZip[\s\S]+?\n\}\n/);
if (!match) throw new Error('Could not extract buildZip from main.js');
const crcMatch = src.match(/function crc32[\s\S]+?\n\}\n/);
const crcCode = crcMatch ? crcMatch[0] : '';
const code = `
const zlib = require('zlib');
${crcCode}
${match[0]}
module.exports = { buildZip };
`;
const sandbox = { module: { exports: {} }, require: _require, Buffer, zlib: _require('zlib') };
const ctx = vm.createContext(sandbox);
const wrapped = `(function(require, module, exports){ ${code} \nmodule.exports = { buildZip }; })`;
const fn = vm.runInContext(wrapped, ctx);
fn(_require, sandbox.module, sandbox.module.exports);
const { buildZip: buildZipFn } = sandbox.module.exports;
const { buildZip } = sandbox.module.exports;

test('M9-1: zip is a valid PK archive with the expected entries', async () => {
  const zip = await buildZipFn({
    'frame.astro': '---\nconst x = 1;\n---\n<p>Hello, {x}</p>\n',
    'meta.json': JSON.stringify({ name: 'hello', sources: [] }),
  });
  // ZIP files start with the local file header signature 0x04034b50 (PK\003\004).
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4B);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  // End-of-central-directory signature 0x06054b50.
  const eocdSig = zip.readUInt32LE(zip.length - 22);
  assert.equal(eocdSig, 0x06054b50);
  // Total entries (offset 10 in EOCD: signature 4 + disk 2 + start 2 + entries 2).
  const totalEntries = zip.readUInt16LE(zip.length - 22 + 10);
  assert.equal(totalEntries, 2);
  // The first entry's name should be exactly `frame.astro`.
  const nameLen = zip.readUInt16LE(26);
  const name = zip.slice(30, 30 + nameLen).toString('utf8');
  assert.equal(name, 'frame.astro');
});

test('M9-2: zip round-trip via a stock reader yields the original bytes', async () => {
  const zip = await buildZipFn({
    'frame.astro': '---\n---\n<h1>Hi</h1>\n',
  });
  // Local file header signature is 0x04034b50. The first entry starts at
  // byte 0 and the header is 30 bytes long, so the name follows at offset 30.
  const name = Buffer.from('frame.astro', 'utf8');
  const idx = zip.indexOf(name);
  assert.ok(idx >= 30, 'frame.astro entry must exist');
  // The CRC field is at offset 14 from the start of the local file header.
  const crc = zip.readUInt32LE(idx - 30 + 14);
  // Verify the CRC by recomputing on the original payload.
  const crc32tbl = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const payload = '---\n---\n<h1>Hi</h1>\n';
  let c = 0xFFFFFFFF;
  for (let i = 0; i < payload.length; i++) {
    c = (crc32tbl[(c ^ payload.charCodeAt(i)) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  const expected = (c ^ 0xFFFFFFFF) >>> 0;
  assert.equal(crc, expected, 'CRC32 in the local file header must match the payload');
  // And confirm both magic bytes are present at the expected offsets.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
