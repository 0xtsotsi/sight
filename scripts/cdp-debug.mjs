import { chromium } from 'playwright';
const cdp = await chromium.connectOverCDP('http://localhost:9222');
const page = cdp.contexts()[0].pages()[0];
await new Promise(r => setTimeout(r, 8000));
const r = await page.evaluate(() => ({
  rootChildren: document.getElementById('root')?.children.length || 0,
  scripts: Array.from(document.scripts).map(s => s.src || '(inline)'),
  title: document.title,
  url: location.href,
}));
console.log('before reload:', JSON.stringify(r, null, 2));
await page.reload({ waitUntil: 'load' });
await new Promise(r => setTimeout(r, 5000));
const r2 = await page.evaluate(() => ({
  rootChildren: document.getElementById('root')?.children.length || 0,
  title: document.title,
  url: location.href,
}));
console.log('after reload:', JSON.stringify(r2, null, 2));
await cdp.close();
