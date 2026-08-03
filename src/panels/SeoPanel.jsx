import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptySeoHead,
  normalizeSeoHead,
  JSON_LD_TYPES,
  JSON_LD_FIELDS,
  TWITTER_CARD_MODES,
  OG_TYPES,
  ROBOTS_FLAGS,
  looksLikeUrl,
  buildJsonLd,
  buildAeoSchema,
  renderHeadTags,
} from '../seo/schema.js';
import SocialCardPreview from '../seo/social-preview.jsx';
import {
  PlusIcon,
  TrashIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../ui/Icons.jsx';

const SAVE_DELAY_MS = 500;
const TITLE_LIMIT = 60;
const DESC_LIMIT = 160;

// The per-page Head editor. Reads from .sight/seo.json via the main process,
// writes back with a small debounce so a flurry of edits doesn't trigger
// one disk write per keystroke. Everything round-trips through
// normalizeSeoHead, so the panel never sees `undefined` or malformed shapes.

export default function SeoPanel({
  project,
  page,
  showToast,
}) {
  const projectPath = project?.path || null;
  const pagePath = page?.path || null;

  const [head, setHead] = useState(() => emptySeoHead());
  const [loading, setLoading] = useState(false);
  const [savedAt, setSavedAt] = useState(null); // ms timestamp of last successful save
  const [error, setError] = useState(null);
  const [sitemap, setSitemap] = useState(null); // { path, xml } | null | { missing: true }
  const [sitemapText, setSitemapText] = useState('');
  const [sectionsOpen, setSectionsOpen] = useState({
    basics: true,
    og: true,
    twitter: true,
    jsonLd: true,
    hreflang: false,
    robots: false,
    favicon: false,
    aeo: false,
    sitemap: false,
  });

  const saveTimer = useRef(null);
  const lastSavedRef = useRef(null);

  // ---- load on page change ----------------------------------------------

  useEffect(() => {
    if (!projectPath || !pagePath) {
      setHead(emptySeoHead());
      setSavedAt(null);
      return undefined;
    }
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([
      window.avb.readHead({ projectPath, pagePath }).catch(() => null),
      window.avb.readSitemap(projectPath).catch(() => null),
    ])
      .then(([read, sm]) => {
        if (!live) return;
        const initial = read?.head
          ? normalizeSeoHead(read.head)
          : emptySeoHead();
        setHead(initial);
        lastSavedRef.current = JSON.stringify(initial);
        setSavedAt(read?.savedAt || null);
        if (sm?.missing) {
          setSitemap({ missing: true });
          setSitemapText('');
        } else if (sm?.xml != null) {
          setSitemap({ path: sm.path, xml: sm.xml });
          setSitemapText(sm.xml);
        } else {
          setSitemap(null);
          setSitemapText('');
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(String(e?.message || e));
        setLoading(false);
      });
    return () => {
      live = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [projectPath, pagePath]);

  // ---- save (debounced) -------------------------------------------------

  const flushSave = useCallback(
    async (nextHead) => {
      if (!projectPath || !pagePath) return;
      try {
        const res = await window.avb.writeHead({ projectPath, pagePath, head: nextHead });
        lastSavedRef.current = JSON.stringify(nextHead);
        setSavedAt(res?.savedAt || Date.now());
        setError(null);
      } catch (e) {
        setError(String(e?.message || e));
        if (showToast) showToast(String(e?.message || e), 'error');
      }
    },
    [projectPath, pagePath, showToast]
  );

  const scheduleSave = useCallback(
    (next) => {
      if (!projectPath || !pagePath) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => flushSave(next), SAVE_DELAY_MS);
    },
    [projectPath, pagePath, flushSave]
  );

  // ---- generic updaters -------------------------------------------------

  const update = useCallback(
    (mutator) => {
      setHead((prev) => {
        const draft = normalizeSeoHead(prev);
        const next = mutator(draft) || draft;
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave]
  );

  // ---- section toggle ----------------------------------------------------

  const toggleSection = (id) =>
    setSectionsOpen((s) => ({ ...s, [id]: !s[id] }));

  // ---- sitemap save ------------------------------------------------------

  const saveSitemap = useCallback(async () => {
    if (!projectPath) return;
    try {
      const res = await window.avb.writeSitemap({ projectPath, sitemap: sitemapText });
      setSitemap({ path: res?.path || 'public/sitemap.xml', xml: sitemapText });
      if (showToast) showToast('Sitemap saved.', 'info');
    } catch (e) {
      if (showToast) showToast(String(e?.message || e), 'error');
    }
  }, [projectPath, sitemapText, showToast]);

  // ---- empty / loading states -------------------------------------------

  if (!projectPath || !pagePath) {
    return (
      <div className="props-empty">
        Open a page to edit its SEO &amp; head metadata.
      </div>
    );
  }

  if (loading) {
    return <div className="props-empty">Loading head metadata…</div>;
  }

  // ---- derived -----------------------------------------------------------

  const og = head.og || {};
  const tw = head.twitter || {};
  const aeo = head.aeo || { answer: '', qa: [] };
  const titleLen = (head.title || '').length;
  const descLen = (head.description || '').length;
  const jsonLdType = head.jsonLdType || 'none';
  const jsonLdFields = JSON_LD_FIELDS[jsonLdType] || [];
  const jsonLdObj = buildJsonLd(jsonLdType, head.jsonLd || {});
  const aeoObj = buildAeoSchema(aeo);
  const emittedTags = renderHeadTags(head);

  return (
    <div className="seo-panel panel-section grow">
      <div className="props-title">
        <span>Head</span>
        <span className="seo-saved-indicator">
          {error ? (
            <span className="seo-error" title={error}>Save failed</span>
          ) : savedAt ? (
            <>
              <CheckIcon size={11} />
              <span>Saved</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="seo-body">
        {/* --- Basics ---------------------------------------------------- */}
        <Section
          id="basics"
          label="Basics"
          open={sectionsOpen.basics}
          onToggle={toggleSection}
        >
          <Field label="Page title" hint={`${titleLen}/${TITLE_LIMIT}`} warn={titleLen > TITLE_LIMIT}>
            <input
              type="text"
              value={head.title || ''}
              maxLength={TITLE_LIMIT + 40}
              onChange={(e) => update((d) => { d.title = e.target.value; })}
              placeholder="A short, specific title"
            />
          </Field>
          <Field label="Description" hint={`${descLen}/${DESC_LIMIT}`} warn={descLen > DESC_LIMIT}>
            <textarea
              rows={3}
              value={head.description || ''}
              maxLength={DESC_LIMIT + 60}
              onChange={(e) => update((d) => { d.description = e.target.value; })}
              placeholder="Up to ~160 characters."
            />
          </Field>
          <Field label="Canonical URL" hint={head.canonical && !looksLikeUrl(head.canonical) ? 'URL looks malformed' : ''}>
            <input
              type="text"
              value={head.canonical || ''}
              onChange={(e) => update((d) => { d.canonical = e.target.value; })}
              placeholder="https://example.com/page"
            />
          </Field>
          <Field label="Favicon path" hint="Served from public/">
            <input
              type="text"
              value={head.favicon || ''}
              onChange={(e) => update((d) => { d.favicon = e.target.value; })}
              placeholder="/favicon.ico"
            />
          </Field>
        </Section>

        {/* --- Open Graph ------------------------------------------------ */}
        <Section id="og" label="Open Graph" open={sectionsOpen.og} onToggle={toggleSection}>
          <Field label="OG title">
            <input
              type="text"
              value={og.title || ''}
              onChange={(e) => update((d) => { d.og.title = e.target.value; })}
            />
          </Field>
          <Field label="OG description">
            <textarea
              rows={2}
              value={og.description || ''}
              onChange={(e) => update((d) => { d.og.description = e.target.value; })}
            />
          </Field>
          <Field label="OG image">
            <input
              type="text"
              value={og.image || ''}
              onChange={(e) => update((d) => { d.og.image = e.target.value; })}
              placeholder="/og.png or full URL"
            />
          </Field>
          <Field label="OG URL">
            <input
              type="text"
              value={og.url || ''}
              onChange={(e) => update((d) => { d.og.url = e.target.value; })}
            />
          </Field>
          <Field label="OG type">
            <select
              value={og.type || 'website'}
              onChange={(e) => update((d) => { d.og.type = e.target.value; })}
            >
              {OG_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Site name">
            <input
              type="text"
              value={og.site_name || ''}
              onChange={(e) => update((d) => { d.og.site_name = e.target.value; })}
            />
          </Field>
          <SocialCardPreview seo={head} projectPath={projectPath} />
        </Section>

        {/* --- Twitter --------------------------------------------------- */}
        <Section id="twitter" label="Twitter card" open={sectionsOpen.twitter} onToggle={toggleSection}>
          <Field label="Card style">
            <select
              value={tw.card || 'summary'}
              onChange={(e) => update((d) => { d.twitter.card = e.target.value; })}
            >
              {TWITTER_CARD_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Twitter title">
            <input
              type="text"
              value={tw.title || ''}
              onChange={(e) => update((d) => { d.twitter.title = e.target.value; })}
            />
          </Field>
          <Field label="Twitter description">
            <textarea
              rows={2}
              value={tw.description || ''}
              onChange={(e) => update((d) => { d.twitter.description = e.target.value; })}
            />
          </Field>
          <Field label="Twitter image">
            <input
              type="text"
              value={tw.image || ''}
              onChange={(e) => update((d) => { d.twitter.image = e.target.value; })}
            />
          </Field>
        </Section>

        {/* --- JSON-LD --------------------------------------------------- */}
        <Section id="jsonLd" label="Structured data" open={sectionsOpen.jsonLd} onToggle={toggleSection}>
          <Field label="Schema type">
            <select
              value={jsonLdType}
              onChange={(e) => update((d) => { d.jsonLdType = e.target.value; })}
            >
              {JSON_LD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
          {jsonLdType !== 'none' && (
            <>
              {jsonLdFields.map((f) => {
                const value = (head.jsonLd || {})[f.key];
                if (f.type === 'list') {
                  return (
                    <Field key={f.key} label={f.label}>
                      <textarea
                        rows={3}
                        value={Array.isArray(value) ? value.join('\n') : (value || '')}
                        onChange={(e) => update((d) => {
                          d.jsonLd = d.jsonLd || {};
                          d.jsonLd[f.key] = e.target.value;
                        })}
                      />
                    </Field>
                  );
                }
                if (f.type === 'qaList') {
                  const items = Array.isArray(value) ? value : [];
                  return (
                    <Field key={f.key} label={f.label} group>
                      <QaListEditor
                        items={items}
                        onChange={(next) => update((d) => {
                          d.jsonLd = d.jsonLd || {};
                          d.jsonLd[f.key] = next;
                        })}
                      />
                    </Field>
                  );
                }
                if (f.type === 'breadcrumbs') {
                  const items = Array.isArray(value) ? value : [];
                  return (
                    <Field key={f.key} label={f.label} group>
                      <BreadcrumbEditor
                        items={items}
                        onChange={(next) => update((d) => {
                          d.jsonLd = d.jsonLd || {};
                          d.jsonLd[f.key] = next;
                        })}
                      />
                    </Field>
                  );
                }
                return (
                  <Field key={f.key} label={f.label} warn={f.type === 'url' && value && !looksLikeUrl(value) ? 'URL looks malformed' : ''}>
                    {f.type === 'longtext' ? (
                      <textarea
                        rows={2}
                        value={value || ''}
                        onChange={(e) => update((d) => {
                          d.jsonLd = d.jsonLd || {};
                          d.jsonLd[f.key] = e.target.value;
                        })}
                      />
                    ) : (
                      <input
                        type="text"
                        value={value || ''}
                        onChange={(e) => update((d) => {
                          d.jsonLd = d.jsonLd || {};
                          d.jsonLd[f.key] = e.target.value;
                        })}
                      />
                    )}
                  </Field>
                );
              })}
              <details className="seo-emitted">
                <summary>JSON-LD preview</summary>
                <pre>{JSON.stringify(jsonLdObj, null, 2)}</pre>
              </details>
            </>
          )}
        </Section>

        {/* --- hreflang -------------------------------------------------- */}
        <Section id="hreflang" label="hreflang" open={sectionsOpen.hreflang} onToggle={toggleSection}>
          <RepeatableRows
            rows={head.hreflang || []}
            makeRow={() => ({ locale: '', url: '' })}
            render={(row, idx, setRow, remove) => (
              <div className="seo-pair-row" key={idx}>
                <input
                  type="text"
                  value={row.locale || ''}
                  onChange={(e) => setRow({ ...row, locale: e.target.value })}
                  placeholder="en-US"
                  aria-label="Locale"
                />
                <input
                  type="text"
                  value={row.url || ''}
                  onChange={(e) => setRow({ ...row, url: e.target.value })}
                  placeholder="https://example.com/en/page"
                  aria-label="URL"
                />
                <button className="ghost" onClick={remove} title="Remove">
                  <TrashIcon size={12} />
                </button>
              </div>
            )}
            onChange={(next) => update((d) => { d.hreflang = next; })}
          />
        </Section>

        {/* --- robots ---------------------------------------------------- */}
        <Section id="robots" label="Robots" open={sectionsOpen.robots} onToggle={toggleSection}>
          <div className="seo-checkbox-list">
            {ROBOTS_FLAGS.map((flag) => {
              const checked = (head.robots || []).includes(flag.value);
              return (
                <label key={flag.value} className="seo-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => update((d) => {
                      const set = new Set(d.robots || []);
                      if (e.target.checked) set.add(flag.value);
                      else set.delete(flag.value);
                      d.robots = Array.from(set);
                    })}
                  />
                  <span>{flag.label}</span>
                </label>
              );
            })}
          </div>
        </Section>

        {/* --- AEO ------------------------------------------------------- */}
        <Section id="aeo" label="Answer Engine (AEO)" open={sectionsOpen.aeo} onToggle={toggleSection}>
          <Field label="One-sentence answer" hint="Used as a featured answer snippet">
            <textarea
              rows={2}
              value={aeo.answer || ''}
              onChange={(e) => update((d) => { d.aeo.answer = e.target.value; })}
            />
          </Field>
          <Field label="Q&A pairs" group>
            <QaListEditor
              items={aeo.qa || []}
              onChange={(next) => update((d) => { d.aeo.qa = next; })}
            />
          </Field>
          <details className="seo-emitted">
            <summary>AEO schema preview</summary>
            <pre>{JSON.stringify(aeoObj, null, 2)}</pre>
          </details>
        </Section>

        {/* --- sitemap --------------------------------------------------- */}
        <Section id="sitemap" label="sitemap.xml" open={sectionsOpen.sitemap} onToggle={toggleSection}>
          {sitemap?.missing ? (
            <div className="props-empty" style={{ padding: '8px 0' }}>
              No sitemap.xml yet. Add one to public/ — it'll be served at /sitemap.xml.
            </div>
          ) : (
            <Field label={`File: ${sitemap?.path || 'public/sitemap.xml'}`}>
              <textarea
                rows={6}
                value={sitemapText}
                onChange={(e) => setSitemapText(e.target.value)}
                spellCheck={false}
              />
            </Field>
          )}
          <div className="seo-actions">
            <button className="primary" onClick={saveSitemap} disabled={sitemap?.missing}>
              Save sitemap
            </button>
          </div>
        </Section>

        {/* --- emitted <head> ------------------------------------------- */}
        <details className="seo-emitted seo-emitted-bottom">
          <summary>Emitted &lt;head&gt;</summary>
          <pre>{emittedTags}</pre>
        </details>
      </div>
    </div>
  );
}

// --- small presentational pieces --------------------------------------

function Section({ id, label, open, onToggle, children }) {
  return (
    <div className={`seo-section ${open ? 'open' : ''}`}>
      <button className="seo-section-toggle" onClick={() => onToggle(id)}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span>{label}</span>
      </button>
      {open && <div className="seo-section-body">{children}</div>}
    </div>
  );
}

function Field({ label, hint, warn, children, group }) {
  // A `<label>` wrapping multiple controls is broken: browsers associate the
  // label with the first focusable child and click-to-focus only affects that
  // one. For multi-control groups (Q&A pairs, breadcrumb lists, ...) we render
  // a `<div>` and rely on each control's own label/aria-label.
  const inner = (
    <>
      <span className="seo-field-label">
        {label}
        {hint && <span className="seo-field-hint">{hint}</span>}
      </span>
      {children}
    </>
  );
  if (group) {
    return <div className={`seo-field ${warn ? 'warn' : ''}`}>{inner}</div>;
  }
  return <label className={`seo-field ${warn ? 'warn' : ''}`}>{inner}</label>;
}

function RepeatableRows({ rows, makeRow, render, onChange }) {
  const list = Array.isArray(rows) ? rows : [];
  const add = () => onChange([...list, makeRow()]);
  const setAt = (i, next) => {
    const copy = list.slice();
    copy[i] = next;
    onChange(copy);
  };
  const removeAt = (i) => {
    const copy = list.slice();
    copy.splice(i, 1);
    onChange(copy);
  };
  return (
    <div className="seo-repeatable">
      {list.map((row, i) => (
        <React.Fragment key={i}>
          {render(row, i, (r) => setAt(i, r), () => removeAt(i))}
        </React.Fragment>
      ))}
      <button className="ghost seo-add-row" onClick={add}>
        <PlusIcon size={11} /> Add row
      </button>
    </div>
  );
}

function QaListEditor({ items, onChange }) {
  const list = Array.isArray(items) ? items : [];
  const setAt = (i, next) => {
    const copy = list.slice();
    copy[i] = next;
    onChange(copy);
  };
  const removeAt = (i) => {
    const copy = list.slice();
    copy.splice(i, 1);
    onChange(copy);
  };
  const add = () => onChange([...list, { question: '', answer: '' }]);
  return (
    <div className="seo-repeatable">
      {list.map((row, i) => (
        <div className="seo-qa-row" key={i}>
          <input
            type="text"
            value={row.question || ''}
            onChange={(e) => setAt(i, { ...row, question: e.target.value })}
            placeholder="Question"
          />
          <textarea
            rows={2}
            value={row.answer || ''}
            onChange={(e) => setAt(i, { ...row, answer: e.target.value })}
            placeholder="Answer"
          />
          <button className="ghost" onClick={() => removeAt(i)} title="Remove">
            <TrashIcon size={12} />
          </button>
        </div>
      ))}
      <button className="ghost seo-add-row" onClick={add}>
        <PlusIcon size={11} /> Add Q&amp;A
      </button>
    </div>
  );
}

function BreadcrumbEditor({ items, onChange }) {
  const list = Array.isArray(items) ? items : [];
  const setAt = (i, next) => {
    const copy = list.slice();
    copy[i] = next;
    onChange(copy);
  };
  const removeAt = (i) => {
    const copy = list.slice();
    copy.splice(i, 1);
    onChange(copy);
  };
  const add = () => onChange([...list, { name: '', url: '' }]);
  return (
    <div className="seo-repeatable">
      {list.map((row, i) => (
        <div className="seo-pair-row" key={i}>
          <input
            type="text"
            value={row.name || ''}
            onChange={(e) => setAt(i, { ...row, name: e.target.value })}
            placeholder="Label"
            aria-label="Label"
          />
          <input
            type="text"
            value={row.url || ''}
            onChange={(e) => setAt(i, { ...row, url: e.target.value })}
            placeholder="/path"
            aria-label="URL"
          />
          <button className="ghost" onClick={() => removeAt(i)} title="Remove">
            <TrashIcon size={12} />
          </button>
        </div>
      ))}
      <button className="ghost seo-add-row" onClick={add}>
        <PlusIcon size={11} /> Add crumb
      </button>
    </div>
  );
}
