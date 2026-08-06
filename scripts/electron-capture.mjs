import { chromium } from 'playwright';

const cdp = await chromium.connectOverCDP('http://localhost:9222');
const page = cdp.contexts()[0].pages()[0];

// Wait for full app load with project
await new Promise(r => setTimeout(r, 5000));

// Find ALL clickable elements containing "Agent"
const candidates = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('*'));
  return all.filter(el => {
    const t = (el.textContent || '').trim();
    return t === 'Agent' || t.startsWith('Agent');
  }).slice(0, 5).map(el => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    classes: (el.className || '').toString().slice(0, 80),
    parent: el.parentElement?.tagName + '.' + (el.parentElement?.className || '').slice(0, 60),
  }));
});
console.log('agent candidates:', JSON.stringify(candidates, null, 2));

await cdp.close();
