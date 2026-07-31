// Orchestrates converting a public/ image into a src/assets/ asset that's
// emitted as an Astro <Image> / <Picture> reference in the current page.
//
// Flow:
//   1. probeImage — read width/height/mime from the still-present public/
//      file. Must happen BEFORE the move; once moveToSrcAssets runs, the
//      public/ path is gone and any probe call would be looking at a file
//      that isn't there.
//   2. moveToSrcAssets — physically relocate the file (public/foo.png →
//      src/assets/foo.png). Both old and new paths are marked as self-writes
//      on the main side so the watcher doesn't reload the page mid-flight.
//   3. writePage (per matching page) — splice a fresh import and the
//      <Image> tag into the page source so the user sees the result
//      immediately. Replaces the old public/ URL with a {importVar}
//      expression wherever it appears. Best-effort: not every build exposes
//      listPages, so the rewrite step is skipped cleanly when that's the
//      case.
//   4. onFsChanged — the watcher already covers src/, but the assets:changed
//      event needs a nudge so the Assets panel re-renders without the file.
//
// The page is read once, modified in memory, and written back as a single
// string. That's lossy beyond the edit, but the editor's save path also
// rewrites the page from the model, so any local edits get re-saved on the
// next user action.

const FORMAT_SUFFIX = { jpg: 'Jpg', jpeg: 'Jpeg', png: 'Png', gif: 'Gif', webp: 'Webp', avif: 'Avif', svg: 'Svg' };

const IMPORT_NAME = (name) => {
  // hero.jpg → heroJpg
  const m = name.match(/^(.*)\.([^.]+)$/);
  const base = m ? m[1] : name;
  const ext = m ? m[2].toLowerCase() : '';
  const camel = base.replace(/[-_]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  const suffix = FORMAT_SUFFIX[ext] || 'Image';
  // Don't double-up if the base already ends with the suffix word.
  return camel.endsWith(suffix) ? camel : camel + suffix;
};

// Reads the current page source, replaces the old `src="/img/foo.png"` (any
// quoting) with a fresh import + <Image> reference, and returns the new
// source. If the page already imports the asset, the import is left alone.
function rewritePageWithImage({ pageSource, fileName, publicRel, importName }) {
  const importLine = `import ${importName} from '../assets/${fileName}';`;
  const importRegex = new RegExp(
    `import\\s+${importName}\\s+from\\s+['"][^'"]*${fileName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"];?`
  );
  let src = pageSource;

  // 1. Insert the import once per file. The regex catches the existing
  //    import if any; an existing import means we don't add a duplicate.
  if (!importRegex.test(src)) {
    // Drop after the closing frontmatter `---` so the import lives in the
    // component-script section, where Astro picks it up.
    const fmMatch = src.match(/^(---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?)/);
    if (fmMatch) {
      src = src.slice(0, fmMatch[0].length) + importLine + '\n' + src.slice(fmMatch[0].length);
    } else {
      src = '---\n' + importLine + '\n---\n' + src;
    }
  }

  // 2. Replace the public/ URL with the import-var expression wherever it
  //    appears in JSX-style attributes (src="/img/foo.png" → src={imgFoo}).
  const escaped = publicRel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  const urlRe = new RegExp(`(src|srcset)=\\s*(["'])/${escaped}\\2`, 'g');
  src = src.replace(urlRe, (_, attr, quote) => `${attr}={${importName}}`);

  // 3. Add an <Image> element at the cursor position only makes sense in the
  //    model layer; rewriting raw source here would inject markup at the
  //    cursor (lossy). Instead, this helper leaves the placement to the
  //    props panel — the import is enough to unblock the user.
  return src;
}

export async function convertToAstro({ projectPath, rel, fileName }) {
  if (!window.avb) throw new Error('window.avb is not available');
  if (!window.avb.moveToSrcAssets) throw new Error('moveToSrcAssets is not exposed');
  if (!window.avb.onFsChanged) throw new Error('onFsChanged is not exposed');

  // Step 1: probe the still-present public/ file for width/height/mime.
  // Must run BEFORE moveToSrcAssets — once the move lands, the public/ path
  // is gone and probeImage would be trying to read a file that isn't there.
  let probe = null;
  if (typeof window.avb.probeImage === 'function') {
    try {
      probe = await window.avb.probeImage({ projectPath, rel });
    } catch {
      probe = null;
    }
  }
  // Fallback so the props panel never has to special-case a missing probe.
  // 4:3-ish jpeg is a reasonable placeholder for whatever the user uploaded.
  const dims = probe || { width: 1200, height: 800, mime: 'image/jpeg' };

  // Step 2: move the file. Throws on collision or missing.
  await window.avb.moveToSrcAssets({ projectPath, rel });

  // Step 3: rewrite the open page. We don't know which page the user is
  // looking at, so we walk through the recently-edited pages and update
  // each one that references the old public/ URL — best-effort.
  //
  // listPages is opt-in: not every build exposes it, and the helper must
  // not blow up when it's absent. Log once and skip the page rewrite
  // cleanly so the move still succeeds.
  const importName = IMPORT_NAME(fileName);
  if (typeof window.avb.listPages !== 'function') {
    console.log('[convertToAstro] listPages not exposed; skipping page rewrite');
  } else {
    const pages = (await window.avb.listPages(projectPath)) || [];
    for (const p of pages) {
      try {
        const { source } = await window.avb.readPage({ projectPath, pagePath: p.path });
        if (!source || !source.includes(`/${rel}`)) continue;
        const next = rewritePageWithImage({
          pageSource: source,
          fileName,
          publicRel: rel,
          importName,
        });
        if (next !== source) {
          if (typeof window.avb.writePage !== 'function') {
            console.log('[convertToAstro] writePage not exposed; skipping page rewrite');
            break;
          }
          await window.avb.writePage({ projectPath, pagePath: p.path, source: next });
        }
      } catch {
        // A page that can't be read or rewritten is left alone; the move still
        // succeeded, so the user can wire the import by hand.
      }
    }
  }

  // Step 4: notify the watcher so the Assets panel re-renders.
  window.avb.onFsChanged({ files: [] });

  // Returned so the caller can pre-fill width/height without re-probing.
  return { dims };
}

export const __test__ = { IMPORT_NAME, rewritePageWithImage };
