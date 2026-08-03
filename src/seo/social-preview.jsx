import React, { useEffect, useRef, useState } from 'react';
import {
  buildSocialPreviewHtml,
  buildSocialPreviewSvg,
  normalizeSeoHead,
} from './schema.js';

// Live Open Graph card preview. Calls into the main process via
// window.avb.renderOgPreview (which spins up a hidden BrowserWindow and
// capturePages it), and falls back to a hand-rolled SVG when the IPC
// round-trip fails or hasn't landed yet.
//
// The card is fixed at 1200x630 (the canonical OG image size); we scale it
// down with CSS so it fits the right-rail slot at any width.

const RENDER_DEBOUNCE_MS = 250;

export default function SocialCardPreview({ seo, projectPath }) {
  const [png, setPng] = useState(null);
  const [err, setErr] = useState(null);
  const timer = useRef(null);
  // Persist the latest request id so a slow render can't overwrite a newer one.
  const reqId = useRef(0);

  useEffect(() => {
    const normalized = normalizeSeoHead(seo);
    // Always start with the SVG fallback so the panel never shows a blank slot.
    const svgFallback = `data:image/svg+xml;utf8,${encodeURIComponent(buildSocialPreviewSvg(normalized))}`;
    setPng(svgFallback);

    if (!window.avb?.renderOgPreview) {
      setErr('Live preview unavailable — showing fallback.');
      return undefined;
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const id = ++reqId.current;
      try {
        const html = buildSocialPreviewHtml(normalized);
        const res = await window.avb.renderOgPreview({
          html,
          width: 1200,
          height: 630,
          projectPath: projectPath || null,
        });
        if (id !== reqId.current) return; // a newer request superseded us
        if (res?.pngBase64) {
          setPng(`data:image/png;base64,${res.pngBase64}`);
          setErr(null);
        } else {
          setErr('Preview render failed — showing fallback.');
        }
      } catch (e) {
        if (id !== reqId.current) return;
        setErr(`Preview render failed: ${String(e?.message || e)}`);
      }
    }, RENDER_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [seo, projectPath]);

  return (
    <div className="og-preview">
      <div className="og-preview-frame">
        {png && (
          <img
            src={png}
            alt="Open Graph social card preview"
            width={1200}
            height={630}
            draggable={false}
          />
        )}
      </div>
      {err && <div className="og-preview-error">{err}</div>}
    </div>
  );
}
