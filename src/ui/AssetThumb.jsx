import React, { useRef, useState } from 'react';
import { FileIcon, CodeIcon } from './Icons.jsx';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga|ogg)$/i;
export const TEXT_EXT =
  /\.(css|js|mjs|cjs|ts|json|txt|md|xml|csv|webmanifest|toml|yml|yaml)$/i;
const FONT_DOC_EXT = /\.(woff2?|ttf|otf|eot|pdf|zip)$/i;

const cleanPath = (v) => String(v || '').trim().split(/[?#]/)[0];

// True for values that name a file inside public/ — a root-relative path
// with a known asset extension ("/videos/clip.webm"), not a URL or a route.
export function looksLikeAssetPath(value) {
  const p = cleanPath(value);
  if (!p.startsWith('/') || p.startsWith('//')) return false;
  return (
    IMAGE_EXT.test(p) || VIDEO_EXT.test(p) || AUDIO_EXT.test(p) ||
    TEXT_EXT.test(p) || FONT_DOC_EXT.test(p)
  );
}

// Which picker filter suits a value ("image" | "video" | "audio" | "asset").
export function mediaKindFor(value) {
  const p = cleanPath(value);
  if (VIDEO_EXT.test(p)) return 'video';
  if (AUDIO_EXT.test(p)) return 'audio';
  if (IMAGE_EXT.test(p)) return 'image';
  return 'asset';
}

// Per-segment encoding, so '#', '?' and '%' in a filename survive the trip.
const encodePath = (abs) =>
  abs.replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');

// Served by the main process (see ASSET_SCHEME in electron/main.js). A plain
// file:// URL only loads when the window itself came from file:// — true of a
// packaged build, but in dev the renderer is on http and Chromium blocks
// file:// subresources from it. Try our scheme first, then fall back to
// file:// so a packaged build still works if the scheme is unavailable.
const srcCandidates = (abs) => [
  `stacki-asset://local/${encodePath(abs)}`,
  `file:///${encodePath(abs)}`,
];

// Thumbnail for one asset: images render directly, videos show their first
// frame and play muted on loop while hovered, everything else gets a badge.
// `onImageLoad` reports natural dimensions to the caller when available.
export default function AssetThumb({ file, className = '', onImageLoad, onClick }) {
  const videoRef = useRef(null);
  // Index into srcCandidates; past the end means every source errored.
  const [srcIdx, setSrcIdx] = useState(0);
  React.useEffect(() => setSrcIdx(0), [file.abs]);
  const candidates = React.useMemo(() => srcCandidates(file.abs), [file.abs]);
  const src = candidates[srcIdx];
  const failed = srcIdx >= candidates.length;
  const nextSrc = () => setSrcIdx((i) => i + 1);
  const isText = TEXT_EXT.test(file.name);
  const isVideo = !isText && VIDEO_EXT.test(file.name);
  const isImage = !isText && !isVideo && IMAGE_EXT.test(file.name);

  const hoverPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = true;
    v.muted = true;
    v.play().catch(() => {});
  };
  const hoverStop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try {
      v.currentTime = 0.1;
    } catch {
      /* not seekable yet */
    }
  };

  return (
    <div
      className={`asset-thumb ${className}`}
      onClick={onClick}
      onMouseEnter={isVideo ? hoverPlay : undefined}
      onMouseLeave={isVideo ? hoverStop : undefined}
    >
      {isImage && !failed ? (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => onImageLoad?.({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          onError={nextSrc}
        />
      ) : isVideo && !failed ? (
        <video
          key={src}
          ref={videoRef}
          // The #t fragment makes Chromium decode and paint a real first
          // frame instead of leaving the element blank until playback.
          src={`${src}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          draggable={false}
          onLoadedMetadata={(e) =>
            onImageLoad?.({ w: e.target.videoWidth, h: e.target.videoHeight })
          }
          onError={nextSrc}
        />
      ) : (
        <span className="asset-ext">
          {isText ? <CodeIcon size={16} /> : <FileIcon size={16} />}
          {(file.name.split('.').pop() || '').toUpperCase().slice(0, 5)}
        </span>
      )}
      {isVideo && !failed && <span className="asset-badge">▶</span>}
    </div>
  );
}
