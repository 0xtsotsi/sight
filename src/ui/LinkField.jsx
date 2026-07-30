import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Dropdown from './Dropdown.jsx';
import AssetField from './AssetField.jsx';
import { ElementLinkIcon, FileIcon, PhoneIcon, ElementImageIcon } from './Icons.jsx';

// Webflow-style link settings for href props: a Type segmented control
// (URL / Page / Section / Email / Phone / Asset) whose fields all compile
// down to one href string. Plain URL mode stays available for anything
// custom; the value's shape picks the initial type.
//
// context: { pages: [{name, route}], sectionIds: [string], projectPath }

const TYPES = [
  { id: 'url', title: 'URL', icon: <ElementLinkIcon size={13} /> },
  { id: 'page', title: 'Page', icon: <FileIcon size={13} /> },
  { id: 'section', title: 'Page section', icon: <b style={{ fontSize: 12 }}>#</b> },
  { id: 'email', title: 'Email', icon: <b style={{ fontSize: 12 }}>@</b> },
  { id: 'phone', title: 'Phone', icon: <PhoneIcon size={13} /> },
  { id: 'asset', title: 'File / asset', icon: <ElementImageIcon size={13} /> },
];

function detectType(str, pages) {
  if (!str) return 'url';
  if (str.startsWith('#')) return 'section';
  if (str.startsWith('mailto:')) return 'email';
  if (str.startsWith('tel:')) return 'phone';
  if ((pages || []).some((p) => p.route === str)) return 'page';
  if (str.startsWith('/') && /\.[a-z0-9]+$/i.test(str)) return 'asset';
  return 'url';
}

function parseMailto(str) {
  const m = String(str).match(/^mailto:([^?]*)(?:\?(.*))?$/);
  if (!m) return { email: '', subject: '' };
  let subject = '';
  try {
    subject = new URLSearchParams(m[2] || '').get('subject') || '';
  } catch {
    /* malformed query — leave subject empty */
  }
  return { email: m[1] || '', subject };
}

export default function LinkField({ value, context, onChange }) {
  const str = value && value.type === 'string' ? value.value : '';
  const [type, setType] = useState(() => detectType(str, context.pages));
  const lastRef = useRef(str);

  // External changes (undo, switching nodes without remount) re-detect.
  useEffect(() => {
    if (str !== lastRef.current) {
      setType(detectType(str, context.pages));
      lastRef.current = str;
    }
  }, [str]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next, immediate = false) => {
    lastRef.current = next;
    onChange({ type: 'string', value: next }, immediate);
  };

  // Sliding highlight behind the active type button.
  const btnRefs = useRef({});
  const [indicator, setIndicator] = useState(null);
  useLayoutEffect(() => {
    const el = btnRefs.current[type];
    setIndicator(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [type]);

  const { email, subject } = type === 'email' ? parseMailto(str) : { email: '', subject: '' };

  return (
    <>
      <div className="link-types">
        {indicator && <span className="link-types-indicator" style={indicator} />}
        {TYPES.map((t) => (
          <button
            key={t.id}
            ref={(el) => (btnRefs.current[t.id] = el)}
            type="button"
            className={type === t.id ? 'on' : ''}
            title={t.title}
            onClick={() => setType(t.id)}
          >
            {t.icon}
          </button>
        ))}
      </div>

      {type === 'url' && (
        <input
          value={str}
          placeholder="https://… or /path"
          spellCheck={false}
          onChange={(e) => commit(e.target.value)}
        />
      )}

      {type === 'page' && (
        <Dropdown
          value={(context.pages || []).some((p) => p.route === str) ? str : ''}
          placeholder="Choose a page…"
          options={(context.pages || []).map((p) => ({
            value: p.route,
            label: `${p.name.replace(/\.(astro|md)$/i, '')}  ·  ${p.route}`,
          }))}
          onChange={(v) => commit(v, true)}
        />
      )}

      {type === 'section' &&
        ((context.sectionIds || []).length > 0 ? (
          <Dropdown
            value={
              str.startsWith('#') && (context.sectionIds || []).includes(str.slice(1)) ? str : ''
            }
            placeholder="Choose a section…"
            options={(context.sectionIds || []).map((id) => ({ value: `#${id}`, label: `#${id}` }))}
            onChange={(v) => commit(v, true)}
          />
        ) : (
          <div className="link-note">
            No elements on this page have an <code>id</code> yet — set one in an element's
            attributes to anchor-link to it.
          </div>
        ))}

      {type === 'email' && (
        <>
          <input
            value={email}
            placeholder="e.g. bob@gmail.com"
            spellCheck={false}
            onChange={(e) =>
              commit(
                `mailto:${e.target.value.trim()}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`
              )
            }
          />
          <input
            value={subject}
            placeholder="Subject (optional)"
            onChange={(e) =>
              commit(
                `mailto:${email}${e.target.value ? `?subject=${encodeURIComponent(e.target.value)}` : ''}`
              )
            }
          />
        </>
      )}

      {type === 'phone' && (
        <input
          value={str.startsWith('tel:') ? str.slice(4) : ''}
          placeholder="e.g. +14155551212"
          spellCheck={false}
          onChange={(e) => commit(`tel:${e.target.value.replace(/\s+/g, '')}`)}
        />
      )}

      {type === 'asset' && (
        <AssetField
          value={detectType(str, context.pages) === 'asset' ? str : ''}
          mediaKind="asset"
          projectPath={context.projectPath}
          showModeToggle={false}
          onChange={(v, immediate) => commit(v || '', immediate)}
        />
      )}
    </>
  );
}
