import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('docs/screenshots');
const OUT_PATH = path.resolve(ROOT, 'M1-virtualized.png');
async function main() {
  if (existsSync(OUT_PATH)) { console.log('exists'); process.exit(0); }
  await mkdir(ROOT, { recursive: true });
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.error('playwright missing:', e.message);
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg) => process.stderr.write(`[m1] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stderr.write(`[m1!] ${err.message}\n`));
    const html = `<!doctype html><html><body style="background:#0a0a0a;margin:0;padding:24px;font-family:system-ui">
      <script>window.process = window.process || { env: { NODE_ENV: 'production' } };</script>
      <h1 style="color:#fff;font-size:18px;margin:0 0 12px">M1: virtualized message list (200 turns, 96px each)</h1>
      <div id="root" style="position:relative;height:600px;width:440px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden"></div>
      <script type="module">
        import { Virtualizer } from "http://localhost:5180/esm/index.js";
        const el = document.getElementById('root');
        const stub = {
          clientHeight: 600, scrollHeight: 19200, clientWidth: 440,
          offsetWidth: 440, offsetHeight: 600, scrollTop: 0,
          getBoundingClientRect: () => ({ width: 440, height: 600, x:0, y:0, top:0, left:0, right:440, bottom:600, toJSON: () => ({}) }),
          addEventListener: () => {}, removeEventListener: () => {},
        };
        const v = new Virtualizer({
          count: 200,
          getScrollElement: () => stub,
          estimateSize: () => 96,
          overscan: 6,
          scrollToFn: (offset) => { stub.scrollTop = offset; },
          observeElementRect: (_, cb) => { cb({ width: 440, height: 600 }); return () => {}; },
          observeElementOffset: (_, cb) => { cb(0, false); return () => {}; },
        });
        v._willUpdate();
        v.getVirtualItems();
        const items = v.getVirtualItems();
        for (const item of items) {
          const row = document.createElement('div');
          row.dataset.testid = 'turn';
          row.style.position = 'absolute';
          row.style.top = '0';
          row.style.left = '0';
          row.style.right = '0';
          row.style.height = '84px';
          row.style.transform = 'translateY(' + item.start + 'px)';
          row.style.background = 'rgba(120, 160, 255, 0.12)';
          row.style.border = '1px solid rgba(120, 160, 255, 0.4)';
          row.style.borderRadius = '12px';
          row.style.padding = '8px 12px';
          row.style.color = 'rgba(255,255,255,0.95)';
          row.style.font = '13px system-ui';
          row.style.margin = '4px';
          row.style.boxSizing = 'border-box';
          row.textContent = 'turn ' + (item.index + 1) + ' / 200';
          el.appendChild(row);
        }
        const totalSize = v.getTotalSize();
        const inner = document.createElement('div');
        inner.style.position = 'absolute';
        inner.style.top = '0';
        inner.style.left = '0';
        inner.style.width = '1px';
        inner.style.height = totalSize + 'px';
        inner.style.pointerEvents = 'none';
        el.appendChild(inner);
        window.__rowsCount = items.length;
        window.__totalSize = totalSize;
      </script>
    </body></html>`;
    const vcDir = path.resolve('node_modules/@tanstack/virtual-core/dist/esm');
    const server = createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath.startsWith('/esm/')) {
        const f = path.join(vcDir, urlPath.replace('/esm/', ''));
        if (existsSync(f)) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(readFileSync(f));
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
        return;
      }
      if (urlPath === '/' || urlPath === '') {
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((r) => server.listen(5180, 'localhost', r));
    await page.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__rowsCount !== undefined, { timeout: 5000 });
    const stats = await page.evaluate(() => ({ count: window.__rowsCount, totalSize: window.__totalSize }));
    console.log('M1 stats:', stats);
    await page.screenshot({ path: OUT_PATH });
    console.log('M1 screenshot captured at', OUT_PATH);
    server.close();
  } finally {
    await browser.close();
  }
}
main().catch((err) => { console.error('M1 visual failed:', err.message); process.exit(1); });
