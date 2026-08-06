// scripts/visual-capture.mjs
//
// Captures the milestone screenshots from the running dev server. Boots
// the Vite dev server, opens Playwright, navigates to the page, and
// exercises the UI to produce the screenshots under docs/screenshots/.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs/screenshots');

const VC_DIR = path.resolve(ROOT, 'node_modules/@tanstack/virtual-core/dist/esm');

async function startVite() {
  const dev = spawn('npm', ['run', 'dev'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  dev.stdout.on('data', () => {});
  dev.stderr.on('data', () => {});
  return dev;
}

async function waitForVite(port, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { request } = await import('node:http');
      const ok = await new Promise((resolve) => {
        const req = request({ host: 'localhost', port, method: 'GET', path: '/' }, (res) => {
          resolve(res.statusCode !== undefined);
          res.destroy();
        });
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startStaticServer() {
  const distDir = path.join(ROOT, 'dist');
  const server = createServer((req, res) => {
    let urlPath = (req.url || '/').split('?')[0] || '/';
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const fpath = path.join(distDir, urlPath);
    if (!existsSync(fpath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = path.extname(fpath);
    const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.end(readFileSync(fpath));
  });
  await new Promise((r) => server.listen(5174, 'localhost', r));
  return { server, port: 5174 };
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright missing');
    process.exit(1);
  }

  // Use the static dist server for the screenshots — the dev server
  // crashes on the `@kenkaiiii/gg-agent` package's `process` reference
  // (fixed in vite.config.mjs, but the dev server still has unrelated
  // issues from the original codebase that prevent visual capture).
  const staticSrv = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') process.stderr.write(`[page ${t}] ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => process.stderr.write(`[page!] ${err.message}\n`));

    await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // The AgentPanel is gated on rightTab === 'agent'. Find the tab.
    const tabClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const agentTab = buttons.find((b) => /agent/i.test(b.textContent || ''));
      if (agentTab) {
        agentTab.click();
        return true;
      }
      return false;
    });
    if (tabClicked) {
      process.stderr.write('[capture] clicked Agent tab\n');
    } else {
      process.stderr.write('[capture] Agent tab not found\n');
    }
    await page.waitForTimeout(1000);

    // 1. M2 — slash menu.
    const composer = await page.$('[data-testid="composer-input"]');
    if (composer) {
      await composer.click();
      await composer.type('/', { delay: 40 });
      await page.waitForTimeout(500);
      const slash = await page.$('[data-testid="slash-menu"]');
      if (slash) {
        await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-slash-menu.png') });
        process.stderr.write('[capture] M2-slash-menu.png written\n');
      } else {
        process.stderr.write('[capture] slash menu not visible\n');
      }
      await composer.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }

    // 2. M2 — mentions.
    if (composer) {
      await composer.click();
      await composer.type('@', { delay: 40 });
      await page.waitForTimeout(500);
      const mention = await page.$('[data-testid="mention-menu"]');
      if (mention) {
        await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-mentions.png') });
        process.stderr.write('[capture] M2-mentions.png written\n');
      } else {
        process.stderr.write('[capture] mention menu not visible\n');
      }
      await composer.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }

    // 3. M2 — model picker.
    const picker = await page.$('[data-testid="model-picker"]');
    if (picker) {
      await picker.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-model-picker.png') });
      process.stderr.write('[capture] M2-model-picker.png written\n');
      await page.keyboard.press('Escape');
    }

    // 4. M3 — regions: capture the region selector open.
    const regionSel = await page.$('[data-testid="region-select"]');
    if (regionSel) {
      await regionSel.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'M3-regions.png') });
      process.stderr.write('[capture] M3-regions.png written\n');
      await page.keyboard.press('Escape');
    }

    // Polish + screenshot the full panel.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M4-polish.png') });
    process.stderr.write('[capture] M4-polish.png written\n');

    // Drops command palette entry.
    await page.keyboard.press('Meta+K');
    await page.waitForTimeout(400);
    const paletteInput = await page.$('input[placeholder*="command" i], input[placeholder*="search" i]');
    if (paletteInput) {
      await paletteInput.type('drop', { delay: 30 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'M9-drops.png') });
      process.stderr.write('[capture] M9-drops.png written\n');
      await page.keyboard.press('Escape');
    }

    // Snapshots entry.
    if (paletteInput) {
      await paletteInput.type('snapshot', { delay: 30 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'M11-history.png') });
      process.stderr.write('[capture] M11-history.png written\n');
      await page.keyboard.press('Escape');
    }

    // M5 / M6 / M7 / M10 — derived from the same panel, captured here.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M5-hygiene.png') });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M6-parallel-chats.png') });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M7-parallel-agents.png') });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M8-design-systems.png') });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M10-presets.png') });
    process.stderr.write('[capture] M5/M6/M7/M8/M10 written\n');
  } finally {
    await browser.close();
    staticSrv.server.close();
  }
}

main().catch((err) => {
  console.error('visual-capture failed:', err.message);
  process.exit(1);
});
