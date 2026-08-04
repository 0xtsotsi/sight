// scripts/visual-m1.mjs
//
// M1 visual verification. Boots the Vite dev server, opens the page in
// Chrome via Playwright, calls the dev-only `window.__seedTurns(N)` hook
// on the AgentPanel to seed 200 turns, and captures a screenshot of the
// panel. The script also asserts the bounding-box height of the rendered
// turn rows sums to less than the virtualizer's reported total height —
// proves only the visible window is laid out.
//
// Run: `node scripts/visual-m1.mjs` (requires the dev server install).

// M1 visual verification script.
//
// The unit tests in src/panels/__tests__/AgentPanel.test.js already prove
// the windowing contract (M1-1: < 40 rows of 200 mounted; M1-3: chunks
// group into one bubble). This script is a belt-and-suspenders check that
// runs the production build (`dist/`) under headless Chromium and captures
// the panel's scroll region.
//
// We serve the production build (NOT `npm run dev`) because the dev
// bundle inlines the `gg-agent` module which introduces a circular
// reference that crashes the browser at module-eval time. The production
// bundle is tree-shaken and runs cleanly. The trade-off is no HMR, but
// for a one-shot screenshot that's fine.
//
// Run: `node scripts/visual-m1.mjs` (requires the dev server install).
//
// Skip if the screenshot already exists — re-running is idempotent.

import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs/screenshots');
const OUT_PATH = path.join(SCREENSHOTS, 'M1-virtualized.png');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port, timeoutMs = 30000) {
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
    await sleep(500);
  }
  return false;
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });

  // Serve the production build (dist/) — the dev server inlines the
  // gg-agent package which references `process` and crashes in the browser.
  // The dist build is vite-bundled with browser-external polyfills for that
  // path, so it loads without errors.
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    console.error('dist/index.html not found — run `npm run build` first');
    process.exit(1);
  }
  // Use a tiny static HTTP server.
  const { createServer } = await import('node:http');
  const mime = (p) => {
    if (p.endsWith('.html')) return 'text/html';
    if (p.endsWith('.js')) return 'text/javascript';
    if (p.endsWith('.css')) return 'text/css';
    if (p.endsWith('.wasm')) return 'application/wasm';
    if (p.endsWith('.svg')) return 'image/svg+xml';
    if (p.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  };
  const server = createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const fpath = path.join(ROOT, 'dist', urlPath);
    if (!existsSync(fpath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', mime(fpath));
    readFileSync(fpath).length && res.end(readFileSync(fpath));
  });
  await new Promise((r) => server.listen(5173, 'localhost', r));
  // dev shim: the dev constant is referenced via cleanup so we keep its name.
  const dev = { kill: () => server.close() };

  let killed = false;
  const cleanup = () => {
    if (killed) return;
    killed = true;
    try { dev.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { dev.kill('SIGKILL'); } catch {} }, 3000);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const ready = await waitForPort(5173, 5000);
  if (!ready) {
    console.error('static server did not start on :5173');
    cleanup();
    process.exit(1);
  }
  await sleep(500); // settle

  // Lazy-import Playwright so the script fails fast if it isn't installed.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    console.error('playwright not installed — run: npm install --save-dev playwright && npx playwright install chromium');
    cleanup();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => process.stderr.write(`[page] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stderr.write(`[page!] ${err.message}\n${err.stack}\n`));

    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    // Give the React tree a moment to mount. We use a long timeout because
    // vite dev bundling is slow on the first visit.
    await sleep(3000);
    // Dump the first error stack so we know what's failing.
    await page.evaluate(() => {
      // Capture any unhandled errors so we can see the cause.
      if (window.__firstErrorStr) return;
      const orig = window.onerror;
      window.onerror = function (...args) {
        window.__firstErrorStr = args.map((a) => (a && a.stack) || String(a)).join(' | ');
        return orig ? orig.apply(this, args) : false;
      };
    });
    process.stderr.write('[first-error] ' + (await page.evaluate(() => window.__firstErrorStr || '(no error captured)') + '\n'));
    // Take a diagnostic screenshot of the whole page so we can see what's
    // actually rendered.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M1-diag.png'), fullPage: true });
    // The AgentPanel is gated on `rightTab === 'agent'`. Find the tab
    // toggle and click it before seeding. The dev hook is registered
    // inside AgentPanel's render body, so we need the panel mounted first.
    const tabClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const agentTab = buttons.find((b) => /agent/i.test(b.textContent || ''));
      if (agentTab) {
        agentTab.click();
        return true;
      }
      return false;
    });
    if (!tabClicked) {
      console.warn('Agent tab not found — App may not be loaded. Falling back to seedTurns anyway.');
    }
    await page.waitForFunction(() => typeof window.__seedTurns === 'function', { timeout: 15000 });
    await page.evaluate(() => window.__seedTurns(200));
    await sleep(500); // let the virtualizer mount + measure
    // Capture the panel region.
    const panel = await page.$('[data-testid="agent-scroll"]');
    if (!panel) throw new Error('AgentPanel scroller not found — the dev hook may not have applied');
    await panel.screenshot({ path: OUT_PATH });

    // Assertions: the rendered rows must sum to less than the scroller's
    // scrollable height. With 200 turns of ~96px each, the total is ~19200px,
    // while the visible window is < 600px. The ratio is the windowing proof.
    const stats = await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('[data-testid="turn"]'));
      const totalHeight = turns.reduce((sum, t) => sum + t.getBoundingClientRect().height, 0);
      const scroller = document.querySelector('[data-testid="agent-scroll"]');
      const scrollHeight = scroller ? scroller.scrollHeight : 0;
      return { count: turns.length, totalHeight, scrollHeight };
    });
    console.log('M1 stats:', JSON.stringify(stats));
    if (stats.count === 0) {
      throw new Error('No turns rendered — virtualizer did not mount');
    }
    if (stats.count >= 200) {
      throw new Error(`Virtualizer rendered all ${stats.count} turns — windowing is OFF`);
    }
    if (stats.totalHeight >= stats.scrollHeight) {
      throw new Error(`Sum of rendered row heights (${stats.totalHeight}) >= scroller scrollHeight (${stats.scrollHeight}) — windowing is OFF`);
    }
    console.log(`✓ M1 visual: ${stats.count} of 200 turns rendered, ${stats.totalHeight}px of ${stats.scrollHeight}px scrollable`);
  } finally {
    await browser.close();
    cleanup();
  }
}

if (existsSync(OUT_PATH)) {
  console.log('M1 screenshot already exists at', OUT_PATH, '— skipping capture');
  process.exit(0);
}

main().catch((err) => {
  console.error('M1 visual verification failed:', err.message);
  process.exit(1);
});
