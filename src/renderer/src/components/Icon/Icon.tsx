import type { JSX, ReactNode } from 'react'

/**
 * Icon registry. Glyphs come from the reference artboards or the documented
 * no-artboard interaction specs: 16×16 grid, 1.5px stroke, round caps; round
 * joins only where the reference sets them. Colors are contextual — pass
 * `color` (e.g. 'var(--t3)', 'var(--ac-icon)') or let it inherit currentColor.
 */

interface IconDef {
  /** stroke-linejoin="round" present in the reference markup */
  join?: boolean
  /** glyph is filled, not stroked (play, stop, record) */
  filled?: boolean
  node: ReactNode
}

const ICONS = {
  search: {
    node: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </>
    )
  },
  gear: {
    join: true,
    node: (
      <>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
      </>
    )
  },
  sliders: {
    join: true,
    node: (
      <>
        <path d="M3 3v1.5M3 7.5V13M8 3v5.5M8 11.5V13M13 3v2.5M13 8.5V13" />
        <circle cx="3" cy="6" r="1.5" />
        <circle cx="8" cy="10" r="1.5" />
        <circle cx="13" cy="7" r="1.5" />
      </>
    )
  },
  ellipsis: {
    filled: true,
    node: (
      <>
        <circle cx="4" cy="8" r="1" />
        <circle cx="8" cy="8" r="1" />
        <circle cx="12" cy="8" r="1" />
      </>
    )
  },
  folder: {
    join: true,
    node: (
      <path d="M2 5a1.5 1.5 0 011.5-1.5h2.6L8 5.5h4.5A1.5 1.5 0 0114 7v4.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5V5z" />
    )
  },
  plus: { node: <path d="M8 3v10M3 8h10" /> },
  upload: {
    join: true,
    node: (
      <>
        <path d="M8 10V3M5 5.5L8 2.5l3 3" />
        <path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" />
      </>
    )
  },
  download: {
    join: true,
    node: (
      <>
        <path d="M8 3v7M5 7.5L8 10.5l3-3" />
        <path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" />
      </>
    )
  },
  sidebar: {
    join: true,
    node: (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M6.25 2.5v11" />
      </>
    )
  },
  'chevron-left': { join: true, node: <path d="M10 3L5 8l5 5" /> },
  'chevron-right': { join: true, node: <path d="M6 4l4 4-4 4" /> },
  /** tree-expander variant — sits 0.5px higher than the select chevron */
  'chevron-down-tree': { join: true, node: <path d="M4 6l4 4 4-4" /> },
  'chevron-down': { join: true, node: <path d="M4 6.5l4 4 4-4" /> },
  check: { join: true, node: <path d="M3 8.5l3.5 3.5L13 5" /> },
  warning: {
    join: true,
    node: (
      <>
        <path d="M8 2.5L14.5 13h-13L8 2.5z" />
        <path d="M8 6.5V9M8 11h.01" />
      </>
    )
  },
  filter: { join: true, node: <path d="M2.5 4h11M4.5 8h7M6.5 12h3" /> },
  grid: {
    join: true,
    node: (
      <>
        <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
      </>
    )
  },
  /* leading dots are zero-length strokes — round caps render them as points */
  list: { node: <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5M2.75 4.5h.01M2.75 8h.01M2.75 11.5h.01" /> },
  expand: {
    join: true,
    node: <path d="M10 2.5h3.5V6M13.5 2.5L9.25 6.75M6 13.5H2.5V10M2.5 13.5l4.25-4.25" />
  },
  collapse: {
    join: true,
    node: <path d="M9.25 3v3.75H13M13.5 2.5L9.25 6.75M6.75 13V9.25H3M2.5 13.5l4.25-4.25" />
  },
  play: { filled: true, node: <path d="M4 2.8l9 5.2-9 5.2V2.8z" /> },
  stop: { filled: true, node: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /> },
  record: { filled: true, node: <circle cx="8" cy="8" r="5" /> },
  'rotate-cw': {
    join: true,
    node: (
      <>
        <path d="M13.5 8A5.5 5.5 0 1112 4.1" />
        <path d="M12.5 1.5v3h-3" />
      </>
    )
  },
  eye: {
    join: true,
    node: (
      <>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
      </>
    )
  },
  clock: {
    join: true,
    node: (
      <>
        <path d="M8 4.5V8l2.5 1.5" />
        <circle cx="8" cy="8" r="6" />
      </>
    )
  },
  calendar: {
    join: true,
    node: (
      <>
        <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
        <path d="M5 2v3M11 2v3M2.5 6.5h11" />
      </>
    )
  },
  'external-link': {
    join: true,
    node: (
      <>
        <path d="M6.5 3.5H3.5a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V9.5" />
        <path d="M9.5 2.5h4v4M13.5 2.5L8 8" />
      </>
    )
  },
  copy: {
    join: true,
    node: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
      </>
    )
  },
  x: { node: <path d="M4 4l8 8M12 4l-8 8" /> },
  file: {
    join: true,
    node: (
      <>
        <path d="M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2z" />
        <path d="M9 2v3.5h3.5" />
      </>
    )
  },
  image: {
    join: true,
    node: (
      <>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
        <circle cx="6" cy="7" r="1.2" />
        <path d="M13.5 10.5l-3-3-5.5 5" />
      </>
    )
  },
  video: {
    join: true,
    node: (
      <>
        <rect x="2.5" y="3.5" width="8" height="9" rx="1" />
        <path d="M10.5 7l3-2v6l-3-2" />
      </>
    )
  },
  pause: { node: <path d="M5.5 3.5v9M10.5 3.5v9" /> },
  globe: {
    join: true,
    node: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 1.8 2 10.2 0 12M8 2c-2 1.8-2 10.2 0 12" />
      </>
    )
  },
  cursor: { join: true, node: <path d="M2 2l5 12 1.7-4.3L13 8 2 2z" /> },
  save: {
    join: true,
    node: (
      <>
        <path d="M12.5 13.5h-9a1 1 0 01-1-1v-9a1 1 0 011-1h7l3 3v7a1 1 0 01-1 1z" />
        <path d="M5 2.5V6h5V2.5M5.5 13.5V10h5v3.5" />
      </>
    )
  },
  pencil: { join: true, node: <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10l7.5-7.5z" /> },
  sun: {
    node: (
      <>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
      </>
    )
  },
  moon: { join: true, node: <path d="M13.5 9.5A6 6 0 116.5 2.5a5 5 0 007 7z" /> },
  monitor: {
    join: true,
    node: (
      <>
        <rect x="2" y="3" width="12" height="8" rx="1" />
        <path d="M6 13.5h4" />
      </>
    )
  }
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

export interface IconProps {
  name: IconName
  /** rendered px size — the reference uses 11–15 */
  size?: number
  /** stroke (or fill for filled glyphs); defaults to currentColor */
  color?: string
  style?: React.CSSProperties
}

export function Icon({ name, size = 14, color = 'currentColor', style }: IconProps): JSX.Element {
  const def: IconDef = ICONS[name]
  if (def.filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill={color} style={style} aria-hidden>
        {def.node}
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin={def.join ? 'round' : undefined}
      style={style}
      aria-hidden
    >
      {def.node}
    </svg>
  )
}

/** Rounded-square play mark; callers choose product-brand or interaction color. */
export function LogoMark({
  size = 56,
  color = 'var(--ac-icon)'
}: {
  size?: number
  color?: string
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" aria-hidden>
      <rect x="4" y="4" width="48" height="48" rx="14" stroke={color} strokeWidth="1.5" />
      <path d="M23 19l14 9-14 9V19z" fill={color} />
    </svg>
  )
}
