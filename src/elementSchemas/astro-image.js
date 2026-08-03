// Built-in virtual components that come from package-level imports (no .astro
// file on disk). Their props panel lives in src/panels/AstroImagePanel.jsx;
// the schema here is what tells the rest of the editor that <Image> /
// <Picture> are real components with proper fields, not dynamic tags.

const ASTRO_IMAGE_SCHEMA = [
  { name: 'src', type: 'string' },
  { name: 'alt', type: 'string' },
  { name: 'width', type: 'number' },
  { name: 'height', type: 'number' },
  // Responsive-image knobs. The dedicated panel renders these as the right
  // widgets (widths as a list, sizes as text, formats as a multi-select, …)
  // — a plain PropField would force them through a single-line text input.
  { name: 'widths', type: 'other' },
  { name: 'sizes', type: 'string' },
  { name: 'formats', type: 'other' },
  { name: 'quality', type: 'number' },
  { name: 'loading', type: 'enum', options: ['eager', 'lazy'], default: 'lazy' },
  { name: 'decoding', type: 'enum', options: ['auto', 'sync', 'async'], default: 'async' },
];

const ASTRO_PICTURE_SCHEMA = [
  { name: 'src', type: 'string' },
  { name: 'alt', type: 'string' },
  { name: 'width', type: 'number' },
  { name: 'height', type: 'number' },
  { name: 'widths', type: 'other' },
  { name: 'sizes', type: 'string' },
  { name: 'formats', type: 'other' },
  { name: 'fallbackFormat', type: 'enum', options: ['avif', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg'], default: 'png' },
  { name: 'quality', type: 'number' },
  { name: 'loading', type: 'enum', options: ['eager', 'lazy'], default: 'lazy' },
  { name: 'decoding', type: 'enum', options: ['auto', 'sync', 'async'], default: 'async' },
];

// Schema lookup for virtual components, keyed by component name.
const SCHEMAS = {
  Image: ASTRO_IMAGE_SCHEMA,
  Picture: ASTRO_PICTURE_SCHEMA,
};

export function getBuiltinComponentSchema(name) {
  return SCHEMAS[name] || [];
}

// The list of built-in components that should appear in the palette / be
// insertable. Schema is referenced by `name` so the props panel can pull the
// shared fields without redefining them per-instance.
export const builtinComponents = [
  {
    name: 'Image',
    isBuiltin: true,
    importPath: 'astro:assets',
    schema: ASTRO_IMAGE_SCHEMA,
    slots: [],
    extendsTag: null,
    hasRest: false,
    folder: 'Astro',
    path: null,
  },
  {
    name: 'Picture',
    isBuiltin: true,
    importPath: 'astro:assets',
    schema: ASTRO_PICTURE_SCHEMA,
    slots: [],
    extendsTag: null,
    hasRest: false,
    folder: 'Astro',
    path: null,
  },
];

// Default values for a newly-inserted <Image>. Drives what the props panel
// shows on first render so the user has sane numbers to tweak instead of
// starting from blanks.
export const ASTRO_IMAGE_DEFAULTS = {
  widths: [400, 800, 1200, 1600],
  sizes: '(max-width: 800px) 100vw, 800px',
  formats: ['avif', 'webp'],
  quality: 80,
  loading: 'lazy',
  decoding: 'async',
};
