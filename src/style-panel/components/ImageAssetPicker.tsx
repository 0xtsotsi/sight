import { useEffect, useMemo, useState } from 'react'
import { getImageAssets, type ImageAsset } from '../lib/webflow'
import './ImageAssetPicker.css'

type Props = {
  onPick: (url: string) => void
  selectedUrl?: string
}

export default function ImageAssetPicker({ onPick, selectedUrl = '' }: Props) {
  const [assets, setAssets] = useState<ImageAsset[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void getImageAssets()
      .then((items) => {
        if (live) setAssets(items)
      })
      .catch((reason) => {
        if (!live) return
        setAssets([])
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      live = false
    }
  }, [])

  const shown = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return assets ?? []
    return (assets ?? []).filter((asset) => asset.name.toLowerCase().includes(normalizedQuery))
  }, [assets, query])

  return (
    <div className="image-asset-picker">
      <input
        className="u-input image-asset-picker_search"
        placeholder="Search assets…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        spellCheck={false}
        aria-label="Search image assets"
      />
      <div className="image-asset-picker_grid">
        {assets == null ? (
          <span className="image-asset-picker_empty">Loading…</span>
        ) : error ? (
          <span className="image-asset-picker_empty is-error">{error}</span>
        ) : shown.length === 0 ? (
          <span className="image-asset-picker_empty">No images found</span>
        ) : (
          shown.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={`image-asset-picker_item ${asset.url === selectedUrl ? 'is-selected' : ''}`}
              title={asset.name}
              aria-label={`Choose ${asset.name}`}
              aria-pressed={asset.url === selectedUrl}
              onClick={() => onPick(asset.url)}
            >
              <img src={asset.url} alt="" loading="lazy" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}
