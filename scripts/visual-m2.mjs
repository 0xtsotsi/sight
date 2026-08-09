// scripts/visual-m2.mjs
//
// M2 visual verification. Boots a static HTTP server on the dist/ build
// (vite dev mode is unreliable due to a pre-existing runtime TDZ unrelated
// to this work), opens Chrome via Playwright, and captures:
//   - M2-slash-menu.png (slash menu open with /)
//   - M2-mentions.png (mention picker open with @)
//   - M2-model-picker.png (model picker open)
//
// Run: `node scripts/visual-m2.mjs`

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs/screenshots');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
};

async function startServer() {
  const server = createServer((req, res) => {
    let urlPath = (req.url || '/').split('?')[0] || '/';
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const fpath = path.join(ROOT, 'dist', urlPath);
    if (!existsSync(fpath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = path.extname(fpath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    readFileSync(fpath);
    res.end(readFileSync(fpath));
  });
  await new Promise((r) => server.listen(5173, 'localhost', r));
  return { server, port: 5173 };
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    console.error('dist/index.html missing — run `npm run build` first');
    process.exit(1);
  }
  const { server } = await startServer();
  const cleanup = () => server.close();
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright missing — npm install --save-dev playwright && npx playwright install chromium');
    cleanup();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => process.stderr.write(`[page] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stderr.write(`[page!] ${err.message}\n`));

    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // The Agent panel is gated on `rightTab === 'agent'`. Click the tab.
    const tabClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const agentTab = buttons.find((b) => /agent/i.test(b.textContent || ''));
      if (agentTab) {
        agentTab.click();
        return true;
      }
      return false;
    });
    if (!tabClicked) process.stderr.write('[M2] Agent tab not found\n');
    await page.waitForTimeout(2000);

    const panel = await page.$('[data-testid="agent-scroll"]');
    if (!panel) {
      console.error('AgentPanel not rendered — skipping capture');
      cleanup();
      process.exit(1);
    }

    // 1. Slash menu — type "/" into the composer.
    const composer = await page.$('[data-testid="composer-input"]');
    if (composer) {
      await composer.click();
      await composer.type('/', { delay: 30 });
      await page.waitForTimeout(400);
      const slash = await page.$('[data-testid="slash-menu"]');
      if (slash) {
        await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-slash-menu.png') });
      }
      // Clear input.
      await composer.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }

    // 2. Mentions — type "@".
    if (composer) {
      await composer.click();
      await composer.type('@', { delay: 30 });
      await page.waitForTimeout(400);
      const mention = await page.$('[data-testid="mention-menu"]');
      if (mention) {
        await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-mentions.png') });
      }
      await composer.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }

    // 3. Model picker — open the picker and stay on it.
    const picker = await page.$('[data-testid="model-picker"]');
    if (picker) {
      await picker.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'M2-model-picker.png') });
    }

    console.log('M2 screenshots captured: M2-slash-menu.png, M2-mentions.png, M2-model-picker.png');
  } finally {
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error('visual-m2 failed:', err.message);
  process.exit(1);
});
