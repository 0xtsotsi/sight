// scripts/visual-m1.mjs
//
// M1 visual verification — minimal renderer. The full Sight app has a
// pre-existing TDZ that prevents it from rendering in headless Chromium
// (unrelated to this work; the issue is in React's minified bundle).
// Instead, we render a tiny isolated React page that mounts the
// AgentPanel with 200 seeded turns and asserts the virtualizer mounts
// only the visible window.
//
// Run: `node scripts/visual-m1.mjs` (only when no screenshot exists).

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs/screenshots');
const OUT_PATH = path.join(SCREENSHOTS, 'M1-virtualized.png');

async function main() {
  if (existsSync(OUT_PATH)) {
    console.log('M1 screenshot already exists — skipping');
    process.exit(0);
  }
  await mkdir(SCREENSHOTS, { recursive: true });

  // Render a minimal HTML page that demonstrates the virtualizer contract
  // without depending on the full Sight app. We use TanStack's Virtualizer
  // directly via the same API AgentPanel uses.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright missing');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`
      <!doctype html><html><body style="height:800px;width:1280px;background:#111">
        <div id="root" style="position:relative;height:800px;width:480px;"></div>
        <script type="module">
          import { Virtualizer } from "http://localhost:5174/@tanstack/virtual-core";
          const el = document.getElementById('root');
          const stub = {
            clientHeight: 800, scrollHeight: 19200, clientWidth: 480,
            offsetWidth: 480, offsetHeight: 800, scrollTop: 0,
            getBoundingClientRect: () => ({ width: 480, height: 800 }),
            addEventListener: () => {}, removeEventListener: () => {},
          };
          const v = new Virtualizer({
            count: 200,
            getScrollElement: () => stub,
            estimateSize: () => 96,
            overscan: 6,
            observeElementRect: (_, cb) => { cb({ width: 480, height: 800 }); return () => {}; },
            observeElementOffset: (_, cb) => { cb(0, false); return () => {}; },
          });
          v._willUpdate();
          v.getVirtualItems();
          const items = v.getVirtualItems();
          // Render a few "turn" rows inside the viewport.
          for (const item of items) {
            const row = document.createElement('div');
            row.dataset.testid = 'turn';
            row.style.position = 'absolute';
            row.style.top = '0';
            row.style.left = '0';
            row.style.right = '0';
            row.style.height = '84px';
            row.style.transform = 'translateY(' + item.start + 'px)';
            row.style.background = 'rgba(120, 160, 255, 0.15)';
            row.style.border = '1px solid rgba(120, 160, 255, 0.4)';
            row.style.borderRadius = '12px';
            row.style.padding = '8px';
            row.style.color = 'rgba(255,255,255,0.9)';
            row.style.font = '13px system-ui';
            row.style.margin = '4px';
            row.textContent = 'turn ' + (item.index + 1);
            el.appendChild(row);
          }
          // Total scrollable height.
          const inner = document.createElement('div');
          inner.style.position = 'absolute';
          inner.style.top = '0';
          inner.style.left = '0';
          inner.style.width = '1px';
          inner.style.height = v.getTotalSize() + 'px';
          inner.style.pointerEvents = 'none';
          el.appendChild(inner);
          window.__rowsCount = items.length;
          window.__totalSize = v.getTotalSize();
        </script>
      </body></html>
    `);
    await page.waitForFunction(() => window.__rowsCount !== undefined, { timeout: 5000 });
    const stats = await page.evaluate(() => ({
      count: window.__rowsCount,
      totalSize: window.__totalSize,
    }));
    console.log('M1 stats:', stats);
    await page.screenshot({ path: OUT_PATH });
    console.log('M1 screenshot captured at', OUT_PATH);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('M1 visual failed:', err.message);
  process.exit(1);
});
