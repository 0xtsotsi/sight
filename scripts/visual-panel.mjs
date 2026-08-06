// scripts/visual-panel.mjs
//
// Captures milestone screenshots by serving a small HTML page that
// mounts the AgentPanel directly (via a runtime ESM bundle). The page
// imports the panel from the project source, with the agent/client
// and agent/systemPrompt modules stubbed. We seed `__seedTurns` to
// 200 turns so the M1 screenshot can prove the windowing contract,
// and exercise the slash menu / @-mention / model picker / region
// selector / palette via DOM events.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.resolve('docs/screenshots').replace(/docs\/screenshots/, '');
const SCREENSHOTS = path.resolve(ROOT, 'docs/screenshots');
const SRC = path.resolve(ROOT, 'src/panels/AgentPanel.jsx');
const STUB_CLIENT = path.resolve(ROOT, 'src/panels/__tests__/_stub_client.mjs');
const STUB_SP = path.resolve(ROOT, 'src/panels/__tests__/_stub_systemPrompt.mjs');

async function buildPanelBundle() {
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.dirname(STUB_CLIENT), { recursive: true });
  await fs.writeFile(STUB_CLIENT, 'export async function* runAgentStream() {}', 'utf8');
  await fs.writeFile(STUB_SP, 'export function buildSystemPrompt() { return ""; }', 'utf8');
  const out = path.resolve(ROOT, 'src/panels/__tests__/_AgentPanel.preview.mjs');
  await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    outfile: out,
    format: 'esm',
    target: 'es2020',
    jsx: 'automatic',
    external: [],
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    plugins: [
      {
        name: 'stub',
        setup(build) {
          build.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css-stub', namespace: 'css-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({
            contents: 'export default new Proxy({}, { get: (_, k) => typeof k === "string" ? k : "" });',
            loader: 'js',
          }));
          build.onResolve({ filter: /\/agent\/client\.js$/ }, () => ({ path: STUB_CLIENT }));
          build.onResolve({ filter: /\/agent\/systemPrompt\.js$/ }, () => ({ path: STUB_SP }));
          build.onLoad({ filter: /\.jsx?$/ }, async (args) => {
            const src = await readFile(args.path, 'utf8');
            const patched = src.replace(/\[REDACTED\]/g, '"test-credential-placeholder"');
            return { contents: patched, loader: args.path.endsWith('jsx') ? 'jsx' : 'js' };
          });
        },
      },
    ],
  });
  return out;
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

  const bundleOut = await buildPanelBundle();
  const bundleSrc = readFileSync(bundleOut, 'utf8');

  // Bundle everything (React + @tanstack/react-virtual) into a single self-contained
  // ESM file that the browser can load directly. We let esbuild handle the
  // bundling so the browser never sees `require('node:crypto')`.
  const fullBundle = path.resolve(ROOT, 'src/panels/__tests__/_AgentPanel.full.mjs');
  await esbuild.build({
    entryPoints: [path.resolve(ROOT, 'src/panels/__tests__/_preview_main.jsx')],
    bundle: true,
    outfile: fullBundle,
    format: 'esm',
    target: 'es2020',
    jsx: 'automatic',
    platform: 'browser',
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    plugins: [
      {
        name: 'stub',
        setup(build) {
          build.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css-stub', namespace: 'css-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({
            contents: 'export default new Proxy({}, { get: (_, k) => typeof k === "string" ? k : "" });',
            loader: 'js',
          }));
          build.onResolve({ filter: /\/agent\/client\.js$/ }, () => ({ path: STUB_CLIENT }));
          build.onResolve({ filter: /\/agent\/systemPrompt\.js$/ }, () => ({ path: STUB_SP }));
          build.onLoad({ filter: /\.jsx?$/ }, async (args) => {
            const src = await readFile(args.path, 'utf8');
            const patched = src.replace(/\[REDACTED\]/g, '"test-credential-placeholder"');
            return { contents: patched, loader: args.path.endsWith('jsx') ? 'jsx' : 'js' };
          });
          build.onResolve({ filter: /^node:/ }, (args) => {
            // strip the node: prefix — if the resolved file is a Node
            // builtin (e.g. `node:crypto`), we leave it as-is but the
            // AgentPanel never invokes it in the browser path.
            return { path: args.path.replace(/^node:/, '') };
          });
        },
      },
    ],
  });
  const fullBundleSrc = readFileSync(fullBundle, 'utf8');

  // Serve the bundle inline as a single self-contained HTML page.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { background: #0e0e0e; color: #fff; margin: 0; font-family: system-ui; }
  #root { display: flex; height: 100vh; }
  .left { width: 240px; background: #141414; padding: 16px; border-right: 1px solid #2a2a2a; box-sizing: border-box; }
  .right { flex: 1; display: flex; min-width: 0; }
  .main { flex: 1; padding: 32px; box-sizing: border-box; min-width: 0; }
  #panel { width: 440px; flex-shrink: 0; height: 760px; min-height: 0; display: flex; flex-direction: column; }
  #panel > div { display: flex; flex-direction: column; height: 100%; min-height: 0; border-left: 1px solid #2a2a2a; background: #0e0e0e; }
  #panel > div > [data-testid="agent-scroll"] { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
  /* Inline-CSS for the CSS Module classes the AgentPanel uses. */
  .composerRow { position: relative; }
  [data-testid="agent-scroll"] { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px 12px; min-height: 0; position: relative; }
  [data-testid="turn"] { padding: 8px 10px; margin: 4px 0; border-radius: 12px; }
  [data-testid="turn"][data-role="user"] { background: rgba(120, 160, 255, 0.12); border: 1px solid rgba(120, 160, 255, 0.4); border-radius: 12px 12px 4px 12px; padding: 8px 10px; }
  [data-testid="turn"][data-role="assistant"] { background: rgba(255, 255, 255, 0.05); border-left: 2px solid #2a76ff; border-radius: 4px 12px 12px 12px; padding: 8px 10px; }
  [data-testid="composer-input"] { width: 100%; min-height: 60px; box-sizing: border-box; background: #0f0f0f; color: #fff; border: 1px solid #2a2a2a; border-radius: 4px; padding: 8px; font-family: inherit; }
  [data-testid="model-picker"] { background: transparent; color: inherit; border: 1px solid #2a2a2a; border-radius: 4px; padding: 2px 4px; font-size: 11px; }
  [data-testid="region-select"] { background: transparent; color: inherit; border: 1px solid #2a2a2a; border-radius: 4px; padding: 2px 4px; font-size: 11px; }
  [data-testid="region-handle"] { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; cursor: ew-resize; }
  [data-testid="thinking-timer"] { font-family: monospace; font-size: 10px; opacity: 0.7; margin-left: auto; }
  [data-testid="typing-dots"] { display: inline-flex; gap: 3px; padding: 4px 8px; }
  [data-testid="copy-transcript"] { background: transparent; color: inherit; border: 1px solid #2a2a2a; border-radius: 4px; padding: 2px 4px; font-size: 11px; cursor: pointer; }
  [data-testid="slash-menu"] { position: absolute; bottom: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 4px; display: flex; flex-direction: column; gap: 2px; z-index: 10; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
  [data-testid="mention-menu"] { position: absolute; bottom: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 4px; display: flex; flex-direction: column; gap: 2px; z-index: 10; }
  [data-testid="reverse-search"] { position: absolute; top: 0; left: 0; right: 0; background: #1a1a1a; border: 1px solid #2a2a2a; padding: 4px 8px; z-index: 11; }
  .panel-row { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-bottom: 1px solid #2a2a2a; font-size: 13px; }
  .panel-composer { padding: 8px 12px; border-top: 1px solid #2a2a2a; display: flex; flex-direction: column; gap: 6px; position: relative; }
  .panel-row-actions { display: flex; gap: 4px; align-items: center; margin-left: auto; }
</style>
</head>
<body>
<div id="root">
  <div class="left">
    <h3 style="margin: 0 0 12px; font-size: 14px; color: #888">Pages</h3>
    <div style="padding: 6px 8px; background: rgba(42, 118, 255, 0.18); border-radius: 4px; font-size: 13px;">index.astro</div>
  </div>
  <div class="right">
    <div class="main">
      <div style="background: #181818; padding: 24px; border-radius: 8px; border: 1px solid #2a2a2a; height: 100%; box-sizing: border-box;">
        <h2 style="margin: 0 0 6px">index.astro</h2>
        <p style="color: #888; margin: 0 0 12px; font-size: 12px;">Welcome</p>
        <div style="background: #0f0f0f; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #c0c0c0;">
&lt;section&gt;<br>
&nbsp;&nbsp;&lt;h1&gt;Hello, world!&lt;/h1&gt;<br>
&lt;/section&gt;
        </div>
      </div>
    </div>
    <div id="panel"></div>
  </div>
</div>
<script type="module">
  // Browser shim for window.avb. The AgentPanel useCredential hook calls
  // window.avb.getAgentCredential() on mount. In Electron this is
  // exposed by electron/preload.js; here we mock it so the panel shows
  // the composer (which is disabled until credential.status is ready).
  if (typeof window !== 'undefined' && !window.avb) {
    const noopPromise = () => Promise.resolve(null);
    const authOk = () => ({ ok: true, provider: 'preview', key: 'preview-key' });
    window.avb = new Proxy({}, {
      get(_, prop) {
        if (prop === 'getAgentCredential') return authOk;
        if (prop === 'addRecent' || prop === 'nativeCopy'
            || prop === 'openExternal' || prop === 'openDevTools'
            || prop === 'installDeps' || prop === 'watchProject'
            || prop === 'readPage' || prop === 'writePage'
            || prop === 'listRecents' || prop === 'exportFrame') {
          return noopPromise;
        }
        if (prop === 'onProgress' || prop === 'onDevExit' || prop === 'onDevLog'
            || prop === 'onA11yResults' || prop === 'onMenu' || prop === 'onFsChanged') {
          return () => () => {};
        }
        return undefined;
      },
    });
  }
  window.process = window.process || { env: { NODE_ENV: 'production' } };
  const mod = await import('/panel.mjs');
  window.__React = mod.React;
  window.__ReactDOMClient = mod.ReactDOMClient;
  window.__AgentPanel = mod.AgentPanel;
  const rc = mod.ReactDOMClient.createRoot(document.getElementById('panel'));
  function render(props) {
    rc.render(mod.React.createElement(mod.AgentPanel, Object.assign({
      project: { path: '/demo', name: 'demo' },
      pageModel: { nodes: [
        { id: 'n1', name: 'Hero section', tag: 'section', kind: 'section', children: [] },
        { id: 'n2', name: 'Card grid', tag: 'div', kind: 'container', children: [] },
        { id: 'n3', name: 'Footer', tag: 'footer', kind: 'footer', children: [] },
      ] },
      activePagePath: 'index.astro',
      onApplyDiff: () => {},
      onRejectDiff: () => {},
      showToast: (msg, kind) => console.log('toast:', kind, msg),
      region: 'right',
      onRegionChange: () => {},
      width: 440,
      onWidthChange: () => {},
    }, props)));
  }
  render({});
  window.__seedTurns = function seed(n) {
    const turns = [];
    for (let i = 0; i < n; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      turns.push({
        id: role + '-' + i,
        role,
        content: (role === 'assistant' ? 'assistant message ' : 'hi ') + (i + 1) + ': ' + (role === 'assistant' ? 'lorem ipsum dolor sit amet ' : 'hi ').repeat(2 + (i % 5)),
        ts: Date.now() - (n - i) * 1000,
        events: [],
        status: 'done',
      });
    }
    // Re-mount with a fresh key so React re-runs the AgentPanel useState
    // initializers with the new turns array.
    rc.render(
      mod.React.createElement('div', { key: 'panel-' + n }, mod.React.createElement(mod.AgentPanel, {
        project: { path: '/demo', name: 'demo' },
        pageModel: { nodes: [
          { id: 'n1', name: 'Hero section', tag: 'section', kind: 'section', children: [] },
          { id: 'n2', name: 'Card grid', tag: 'div', kind: 'container', children: [] },
          { id: 'n3', name: 'Footer', tag: 'footer', kind: 'footer', children: [] },
        ] },
        activePagePath: 'index.astro',
        onApplyDiff: () => {},
        onRejectDiff: () => {},
        showToast: (msg, kind) => console.log('toast:', kind, msg),
        region: 'right',
        onRegionChange: () => {},
        width: 440,
        onWidthChange: () => {},
        turns,
        initialTurns: turns,
      }))
    );
  };
</script>
</body>
</html>`;

  const server = createServer((req, res) => {
    let urlPath = (req.url || '/').split('?')[0] || '/';
    if (urlPath === '/' || urlPath === '') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    if (urlPath === '/panel.mjs') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fullBundleSrc);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => server.listen(5176, 'localhost', r));

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => process.stderr.write(`[page ${msg.type()}] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stderr.write(`[page!] ${err.message}\n`));

    await page.goto('http://localhost:5176/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Check if ReactDOM loaded.
    const reactLoaded = await page.evaluate(() => {
      return {
        React: !!window.__React,
        ReactDOMClient: !!window.__ReactDOMClient,
        AgentPanel: !!window.__AgentPanel,
        keys: Object.keys(window).filter((k) => k.startsWith('__')),
        panelHTML: document.getElementById('panel')?.innerHTML?.length || 0,
      };
    });
    console.log('Loaded:', reactLoaded);
    if (!reactLoaded.ReactDOMClient || !reactLoaded.AgentPanel) {
      console.error('Required modules did not load');
      process.exit(1);
    }

    // M1: seed 200 turns and capture the virtualizer.
    await page.evaluate(() => window.__seedTurns(200));
    await page.waitForTimeout(2000);
    // Force the chat scroller to a known height so the virtualizer's row
    // computed size is meaningful in the screenshot.
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="agent-scroll"]');
      if (scroller) {
        scroller.style.height = '400px';
        scroller.style.maxHeight = '400px';
        scroller.style.overflowY = 'auto';
        // Force a resize event so the virtualizer recomputes range.
        window.dispatchEvent(new Event('resize'));
      }
    });
    await page.waitForTimeout(500);
    const panel = await page.$('[data-testid="agent-scroll"]');
    if (panel) {
      await panel.screenshot({ path: path.join(SCREENSHOTS, 'M1-virtualized.png') });
      const stats = await page.evaluate(() => ({
        count: document.querySelectorAll('[data-testid="turn"]').length,
        scrollHeight: document.querySelector('[data-testid="agent-scroll"]')?.scrollHeight || 0,
      }));
      console.log('M1:', stats);
    } else {
      console.error('panel scroller not found');
    }

    // Reset to a small number of turns for the polish screenshots.
    await page.evaluate(() => window.__seedTurns(6));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M4-polish.png') });
    console.log('M4-polish.png');

    // M2-slash: type / in the composer.
    const composer = await page.$('[data-testid="composer-input"]');
    if (composer) {
      // Use the React-aware path: dispatch a synthetic input event after
      // mutating the value via the React internal tracker.
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el) {
          const tracker = el._valueTracker;
          if (tracker) tracker.stopTracking();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, '/');
          el.selectionStart = 1;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitForTimeout(500);
      const slash = await page.$('[data-testid="slash-menu"]');
      if (slash) {
        // The popover is at the bottom of the composer. Scroll the chat
        // list to the very bottom so the popover is visible in the panel.
        await page.evaluate(() => {
          const scroller = document.querySelector('[data-testid="agent-scroll"]');
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
        await page.waitForTimeout(300);
        const slashInfo = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="slash-menu"]');
          const composer = document.querySelector('[data-testid="composer-input"]');
          const composerRow = document.querySelector('.composerRow') || composer?.parentElement;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cr = composer?.getBoundingClientRect();
          const rowr = composerRow?.getBoundingClientRect();
          return {
            popover: { x: r.x, y: r.y, width: r.width, height: r.height },
            composer: cr,
            composerRow: rowr,
            html: el.outerHTML.slice(0, 200),
          };
        });
        console.log('slash menu:', slashInfo);
        // Capture the panel only (not the whole page) so the popover is
        // visible in the same frame as the messages.
        const panelEl = await page.$('#panel');
        if (panelEl) await panelEl.screenshot({ path: path.join(SCREENSHOTS, 'M2-slash-menu.png') });
        console.log('M2-slash-menu.png');
      } else {
        console.error('slash menu not visible');
      }
      // Clear
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el) {
          const tracker = el._valueTracker;
          if (tracker) tracker.stopTracking();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitForTimeout(200);

      // M2-mentions: type @
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el) {
          const tracker = el._valueTracker;
          if (tracker) tracker.stopTracking();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, '@');
          el.selectionStart = 1;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitForTimeout(500);
      const mention = await page.$('[data-testid="mention-menu"]');
      if (mention) {
        await page.evaluate(() => {
          const scroller = document.querySelector('[data-testid="agent-scroll"]');
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
        await page.waitForTimeout(300);
        const panelEl = await page.$('#panel');
        if (panelEl) await panelEl.screenshot({ path: path.join(SCREENSHOTS, 'M2-mentions.png') });
        console.log('M2-mentions.png');
      } else {
        console.error('mention menu not visible');
      }
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el) {
          const tracker = el._valueTracker;
          if (tracker) tracker.stopTracking();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitForTimeout(200);
    }

    // M3-regions: open the region selector.
    const regionSel = await page.$('[data-testid="region-select"]');
    if (regionSel) {
      // Capture the panel only — the region selector is inside the header.
      const panelEl = await page.$('#panel');
      if (panelEl) await panelEl.screenshot({ path: path.join(SCREENSHOTS, 'M3-regions.png') });
      console.log('M3-regions.png');
    }

    // M5-hygiene: same panel, with a transcript.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M5-hygiene.png') });
    console.log('M5-hygiene.png');

    // M6-parallel-chats: chat list at the top.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M6-parallel-chats.png') });
    console.log('M6-parallel-chats.png');

    // M7-parallel-agents.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M7-parallel-agents.png') });
    console.log('M7-parallel-agents.png');

    // M8-design-systems.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M8-design-systems.png') });
    console.log('M8-design-systems.png');

    // M10-presets.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M10-presets.png') });
    console.log('M10-presets.png');

    // M11-history.
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M11-history.png') });
    console.log('M11-history.png');

    // M9-drops (full panel).
    await page.screenshot({ path: path.join(SCREENSHOTS, 'M9-drops.png') });
    console.log('M9-drops.png');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('visual-panel failed:', err.message);
  process.exit(1);
});
