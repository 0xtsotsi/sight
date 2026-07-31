// JSON-LD builders for the seven schema.org types the SEO panel supports,
// plus the AEO (Answer Engine Optimization) Question/Answer list.
//
// All functions are pure: input in, JSON-LD object out. The renderer calls
// these to show a preview and serialize the same shape into a <script
// type="application/ld+json"> tag. No filesystem, no React, no Electron — so
// they can be unit-tested with plain node:test.
//
// Empty / optional fields are dropped (not emitted as empty strings or nulls)
// so search engines don't reject the block for having "":"" properties.

export const JSON_LD_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'Article', label: 'Article' },
  { value: 'Product', label: 'Product' },
  { value: 'FAQPage', label: 'FAQ' },
  { value: 'BreadcrumbList', label: 'BreadcrumbList' },
  { value: 'Organization', label: 'Organization' },
  { value: 'Person', label: 'Person' },
  { value: 'WebSite', label: 'WebSite' },
];

// Twitter card modes (also used by the dropdown in the UI).
export const TWITTER_CARD_MODES = [
  { value: 'summary', label: 'Summary' },
  { value: 'summary_large_image', label: 'Summary with large image' },
];

// Open Graph types worth offering.
export const OG_TYPES = [
  'website',
  'article',
  'book',
  'profile',
  'music.song',
  'music.album',
  'video.movie',
  'video.episode',
  'product',
];

// Robots flag fragments the panel exposes. Each entry is appended to a
// `robots` meta `content` value (e.g. "noindex, nofollow").
export const ROBOTS_FLAGS = [
  { value: 'noindex', label: 'noindex' },
  { value: 'nofollow', label: 'nofollow' },
  { value: 'noarchive', label: 'noarchive' },
  { value: 'nosnippet', label: 'nosnippet' },
  { value: 'notranslate', label: 'notranslate' },
  { value: 'noimageindex', label: 'noimageindex' },
];

// Field shape per JSON-LD type. Each entry lists the editable keys with a
// label and an input hint, so the SeoPanel can render the right fields
// without a giant switch.
export const JSON_LD_FIELDS = {
  Article: [
    { key: 'headline', label: 'Headline', type: 'text' },
    { key: 'description', label: 'Description', type: 'longtext' },
    { key: 'author', label: 'Author name', type: 'text' },
    { key: 'datePublished', label: 'Date published (ISO)', type: 'text' },
    { key: 'image', label: 'Image URL', type: 'url' },
    { key: 'articleSection', label: 'Section', type: 'text' },
  ],
  Product: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'description', label: 'Description', type: 'longtext' },
    { key: 'image', label: 'Image URL', type: 'url' },
    { key: 'brand', label: 'Brand', type: 'text' },
    { key: 'sku', label: 'SKU', type: 'text' },
    { key: 'price', label: 'Price', type: 'text' },
    { key: 'priceCurrency', label: 'Currency (e.g. USD)', type: 'text' },
    { key: 'availability', label: 'Availability', type: 'text' },
  ],
  FAQPage: [
    { key: 'items', label: 'Q&A pairs', type: 'qaList' },
  ],
  BreadcrumbList: [
    { key: 'items', label: 'Breadcrumbs', type: 'breadcrumbs' },
  ],
  Organization: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'url', label: 'URL', type: 'url' },
    { key: 'logo', label: 'Logo URL', type: 'url' },
    { key: 'sameAs', label: 'Same-as URLs (one per line)', type: 'list' },
  ],
  Person: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'jobTitle', label: 'Job title', type: 'text' },
    { key: 'url', label: 'URL', type: 'url' },
    { key: 'image', label: 'Image URL', type: 'url' },
    { key: 'sameAs', label: 'Same-as URLs (one per line)', type: 'list' },
  ],
  WebSite: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'url', label: 'URL', type: 'url' },
    { key: 'description', label: 'Description', type: 'longtext' },
    { key: 'potentialAction', label: 'Search action target', type: 'text' },
  ],
};

// --- empty defaults ------------------------------------------------------

export function emptySeoHead() {
  return {
    title: '',
    description: '',
    canonical: '',
    og: {
      title: '',
      description: '',
      image: '',
      url: '',
      type: 'website',
      site_name: '',
    },
    twitter: {
      card: 'summary',
      title: '',
      description: '',
      image: '',
    },
    jsonLdType: 'none',
    jsonLd: {},
    hreflang: [],
    robots: [],
    favicon: '',
    aeo: {
      answer: '',
      qa: [],
    },
  };
}

// --- normalization -------------------------------------------------------

// Coerces user input into the canonical SeoHead shape. Missing fields fall
// back to defaults; bad shapes are silently coerced to their closest safe
// form (e.g. non-string title → ''). The panel never sees `undefined`.
export function normalizeSeoHead(input) {
  const e = emptySeoHead();
  if (!input || typeof input !== 'object') return e;
  const o = input.og && typeof input.og === 'object' ? input.og : {};
  const t = input.twitter && typeof input.twitter === 'object' ? input.twitter : {};
  const a = input.aeo && typeof input.aeo === 'object' ? input.aeo : {};
  const jsonLd = input.jsonLd && typeof input.jsonLd === 'object' ? input.jsonLd : {};
  const hreflang = Array.isArray(input.hreflang)
    ? input.hreflang
        .filter((h) => h && typeof h === 'object')
        .map((h) => ({ locale: String(h.locale || ''), url: String(h.url || '') }))
    : [];
  const robots = Array.isArray(input.robots)
    ? input.robots.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  return {
    title: String(input.title || ''),
    description: String(input.description || ''),
    canonical: String(input.canonical || ''),
    og: {
      title: String(o.title || ''),
      description: String(o.description || ''),
      image: String(o.image || ''),
      url: String(o.url || ''),
      type: OG_TYPES.includes(o.type) ? o.type : 'website',
      site_name: String(o.site_name || ''),
    },
    twitter: {
      card: t.card === 'summary_large_image' ? 'summary_large_image' : 'summary',
      title: String(t.title || ''),
      description: String(t.description || ''),
      image: String(t.image || ''),
    },
    jsonLdType: JSON_LD_TYPES.some((t) => t.value === input.jsonLdType)
      ? input.jsonLdType
      : 'none',
    jsonLd,
    hreflang,
    robots,
    favicon: String(input.favicon || ''),
    aeo: {
      answer: String(a.answer || ''),
      qa: Array.isArray(a.qa)
        ? a.qa
            .filter((q) => q && typeof q === 'object')
            .map((q) => ({ question: String(q.question || ''), answer: String(q.answer || '') }))
        : [],
    },
  };
}

// --- JSON-LD builders ----------------------------------------------------

function buildArticle(f) {
  const out = { '@context': 'https://schema.org', '@type': 'Article' };
  if (f.headline) out.headline = f.headline;
  if (f.description) out.description = f.description;
  if (f.author) out.author = { '@type': 'Person', name: f.author };
  if (f.datePublished) out.datePublished = f.datePublished;
  if (f.image) out.image = f.image;
  if (f.articleSection) out.articleSection = f.articleSection;
  return out;
}

function buildProduct(f) {
  const out = { '@context': 'https://schema.org', '@type': 'Product' };
  if (f.name) out.name = f.name;
  if (f.description) out.description = f.description;
  if (f.image) out.image = f.image;
  if (f.brand) out.brand = { '@type': 'Brand', name: f.brand };
  if (f.sku) out.sku = f.sku;
  if (f.price || f.priceCurrency) {
    const offer = { '@type': 'Offer' };
    if (f.price) offer.price = f.price;
    if (f.priceCurrency) offer.priceCurrency = f.priceCurrency;
    if (f.availability) offer.availability = f.availability;
    out.offers = offer;
  }
  return out;
}

function buildFAQPage(f) {
  const items = Array.isArray(f.items) ? f.items : [];
  const main = [];
  for (const q of items) {
    if (!q || !q.question || !q.answer) continue;
    main.push({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    });
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: main,
  };
}

function buildBreadcrumbList(f) {
  const items = Array.isArray(f.items) ? f.items : [];
  const list = items
    .filter((b) => b && (b.name || b.url))
    .map((b, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      ...(b.name ? { name: b.name } : {}),
      ...(b.url ? { item: b.url } : {}),
    }));
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: list,
  };
}

function buildOrganization(f) {
  const out = { '@context': 'https://schema.org', '@type': 'Organization' };
  if (f.name) out.name = f.name;
  if (f.url) out.url = f.url;
  if (f.logo) out.logo = f.logo;
  const same = asList(f.sameAs);
  if (same.length) out.sameAs = same;
  return out;
}

function buildPerson(f) {
  const out = { '@context': 'https://schema.org', '@type': 'Person' };
  if (f.name) out.name = f.name;
  if (f.jobTitle) out.jobTitle = f.jobTitle;
  if (f.url) out.url = f.url;
  if (f.image) out.image = f.image;
  const same = asList(f.sameAs);
  if (same.length) out.sameAs = same;
  return out;
}

function buildWebSite(f) {
  const out = { '@context': 'https://schema.org', '@type': 'WebSite' };
  if (f.name) out.name = f.name;
  if (f.url) out.url = f.url;
  if (f.description) out.description = f.description;
  if (f.potentialAction) {
    out.potentialAction = {
      '@type': 'SearchAction',
      target: f.potentialAction,
      'query-input': 'required name=search_term_string',
    };
  }
  return out;
}

const BUILDERS = {
  Article: buildArticle,
  Product: buildProduct,
  FAQPage: buildFAQPage,
  BreadcrumbList: buildBreadcrumbList,
  Organization: buildOrganization,
  Person: buildPerson,
  WebSite: buildWebSite,
};

// Returns the JSON-LD object for the selected type, or null for `none`.
// Unrecognized types are treated as `none` (the panel normalizes that
// anyway) so we never emit a half-broken block.
export function buildJsonLd(type, fields) {
  if (!type || type === 'none') return null;
  const fn = BUILDERS[type];
  if (!fn) return null;
  const f = fields && typeof fields === 'object' ? fields : {};
  return fn(f);
}

// --- AEO: separate question/answer JSON-LD list --------------------------

// AEO pairs are emitted as their own <script> block — schema.org/Question is
// recognized by Answer Engine Optimization surfaces (Perplexity, Bing Chat,
// Google's AI Overviews) and they don't have to live inside the page's
// primary schema type. Empty questions/answers are dropped.
export function buildAeoSchema(aeo) {
  const out = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [] };
  if (!aeo || typeof aeo !== 'object') return out;
  if (aeo.answer) {
    out.itemListElement.push({
      '@type': 'ListItem',
      position: 1,
      item: {
        '@type': 'Answer',
        text: aeo.answer,
      },
    });
  }
  const qa = Array.isArray(aeo.qa) ? aeo.qa : [];
  let pos = out.itemListElement.length + 1;
  for (const q of qa) {
    if (!q || !q.question || !q.answer) continue;
    out.itemListElement.push({
      '@type': 'ListItem',
      position: pos++,
      item: {
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: { '@type': 'Answer', text: q.answer },
      },
    });
  }
  return out;
}

// --- <head> tag emission -------------------------------------------------

// Renders the full meta-tag list as an HTML string, suitable for embedding
// in a <head>. Empty fields are skipped so the block stays minimal.
export function renderHeadTags(head) {
  const h = normalizeSeoHead(head);
  const lines = [];
  if (h.title) lines.push(`<title>${escapeHtml(h.title)}</title>`);
  if (h.description) lines.push(`<meta name="description" content="${escapeAttr(h.description)}" />`);
  if (h.canonical) lines.push(`<link rel="canonical" href="${escapeAttr(h.canonical)}" />`);
  if (h.favicon) lines.push(`<link rel="icon" href="${escapeAttr(h.favicon)}" />`);
  if (h.robots.length) {
    lines.push(`<meta name="robots" content="${escapeAttr(h.robots.join(', '))}" />`);
  }
  for (const row of h.hreflang) {
    if (!row.url || !row.locale) continue;
    lines.push(`<link rel="alternate" hreflang="${escapeAttr(row.locale)}" href="${escapeAttr(row.url)}" />`);
  }
  if (h.og.title) lines.push(`<meta property="og:title" content="${escapeAttr(h.og.title)}" />`);
  if (h.og.description) lines.push(`<meta property="og:description" content="${escapeAttr(h.og.description)}" />`);
  if (h.og.image) lines.push(`<meta property="og:image" content="${escapeAttr(h.og.image)}" />`);
  if (h.og.url) lines.push(`<meta property="og:url" content="${escapeAttr(h.og.url)}" />`);
  if (h.og.type) lines.push(`<meta property="og:type" content="${escapeAttr(h.og.type)}" />`);
  if (h.og.site_name) lines.push(`<meta property="og:site_name" content="${escapeAttr(h.og.site_name)}" />`);
  if (h.twitter.card) lines.push(`<meta name="twitter:card" content="${escapeAttr(h.twitter.card)}" />`);
  if (h.twitter.title) lines.push(`<meta name="twitter:title" content="${escapeAttr(h.twitter.title)}" />`);
  if (h.twitter.description) lines.push(`<meta name="twitter:description" content="${escapeAttr(h.twitter.description)}" />`);
  if (h.twitter.image) lines.push(`<meta name="twitter:image" content="${escapeAttr(h.twitter.image)}" />`);
  const ld = buildJsonLd(h.jsonLdType, h.jsonLd);
  if (ld) {
    lines.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  }
  const aeo = buildAeoSchema(h.aeo);
  if (aeo.itemListElement.length) {
    lines.push(`<script type="application/ld+json">${JSON.stringify(aeo)}</script>`);
  }
  return lines.join('\n');
}

// --- small HTML helpers --------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Turns newline-separated text into a string array; tolerates non-string input.
function asList(v) {
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string') {
    return v
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// --- social card preview HTML --------------------------------------------

// Builds the HTML rendered by Electron's hidden BrowserWindow for the live
// social card preview. Mirrors the canonical OG card sizes (1200x630) and
// uses a clean white-on-dark scheme similar to Twitter / LinkedIn previews.
export function buildSocialPreviewHtml(seo) {
  const h = normalizeSeoHead(seo);
  const og = h.og || {};
  const title = og.title || h.title || 'Untitled page';
  const description = og.description || h.description || '';
  const site = og.site_name || '';
  const image = og.image || '';
  const initials = (title.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase() || '··';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  *,*::before,*::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #1f2230; color: #f3f4f8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .card { width: 1200px; height: 630px; display: flex; flex-direction: column; padding: 56px 64px; gap: 28px; }
  .meta { display: flex; align-items: center; gap: 16px; font-size: 28px; color: #b6bbcc; }
  .meta .dot { width: 14px; height: 14px; border-radius: 50%; background: #4b6bfb; }
  .meta .site { font-weight: 600; color: #dde0ee; }
  .image { flex: 1 1 auto; min-height: 0; border-radius: 28px; background: #2a2e44; background-size: cover; background-position: center; display: flex; align-items: center; justify-content: center; font-size: 96px; font-weight: 700; letter-spacing: 4px; color: #6a708f; overflow: hidden; }
  .image.has-image { color: transparent; }
  .title { font-size: 56px; line-height: 1.1; font-weight: 700; color: #f3f4f8; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .desc { font-size: 28px; line-height: 1.35; color: #aab1c4; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .url { font-size: 22px; color: #7c83a0; margin: 0; word-break: break-all; }
</style>
</head>
<body>
  <div class="card">
    <div class="meta"><span class="dot"></span><span class="site">${escapeHtml(site || 'your-site.example')}</span></div>
    <div class="image ${image ? 'has-image' : ''}" style="${image ? `background-image:url(${escapeAttr(image)})` : ''}">${escapeHtml(initials)}</div>
    <h1 class="title">${escapeHtml(title)}</h1>
    <p class="desc">${escapeHtml(description)}</p>
    <p class="url">${escapeHtml(og.url || h.canonical || '')}</p>
  </div>
</body>
</html>`;
}

// SVG fallback used by the renderer if Electron's capturePage fails or the
// IPC round-trip errors. Same dimensions as the OG card so the panel slot
// doesn't jump.
export function buildSocialPreviewSvg(seo) {
  const h = normalizeSeoHead(seo);
  const og = h.og || {};
  const title = og.title || h.title || 'Untitled page';
  const description = og.description || h.description || '';
  const site = og.site_name || 'your-site.example';
  const url = og.url || h.canonical || '';
  const W = 1200;
  const H = 630;
  const initials = (title.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase() || '··';
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#1f2230"/>
  <rect x="56" y="56" width="14" height="14" rx="7" fill="#4b6bfb"/>
  <text x="86" y="71" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#dde0ee" font-weight="600">${escapeXml(site)}</text>
  <rect x="56" y="110" width="${W - 112}" height="${H - 280}" rx="28" fill="#2a2e44"/>
  <text x="${W / 2}" y="${(H - 280) / 2 + 130}" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="700" fill="#6a708f" text-anchor="middle">${escapeXml(initials)}</text>
  <text x="56" y="${H - 200}" font-family="Helvetica, Arial, sans-serif" font-size="56" font-weight="700" fill="#f3f4f8">${escapeXml(trunc(title, 70))}</text>
  <text x="56" y="${H - 150}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#aab1c4">${escapeXml(trunc(description, 130))}</text>
  <text x="56" y="${H - 90}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#7c83a0">${escapeXml(trunc(url, 90))}</text>
</svg>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- validation helpers --------------------------------------------------

// Permits http(s), mailto, tel, and any relative path — search engines and
// crawlers handle all of these, and a relative URL is normal on a static
// site served under a base path.
export function looksLikeUrl(s) {
  if (!s) return true; // empty is allowed; warn separately
  if (/^https?:\/\//i.test(s)) return true;
  if (/^mailto:/i.test(s)) return true;
  if (/^tel:/i.test(s)) return true;
  if (s.startsWith('/')) return true;
  if (s.startsWith('./') || s.startsWith('../')) return true;
  if (/^[a-z0-9.\-]+(\/|$)/i.test(s)) return true; // bare relative
  return false;
}

export function clipText(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}
