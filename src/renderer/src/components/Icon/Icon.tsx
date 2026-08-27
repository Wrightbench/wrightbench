import { useId, type JSX, type ReactNode } from 'react'

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

/** Theme-stable Wrightbench product mark from the canonical native icon source. */
export function LogoMark({
  size = 56,
  color = 'var(--brand-mark)'
}: {
  size?: number
  color?: string
}): JSX.Element {
  const id = useId().replaceAll(':', '')
  const clip = (name: string): string => `url(#${id}-${name})`

  return (
    <svg width={size} height={size} viewBox="0 0 1500 1499.999933" fill="none" aria-hidden>
      <defs>
        <clipPath id={`${id}-canvas`}><path d="M121 206H1377V1306H121Z" /></clipPath>
        <clipPath id={`${id}-outer-a`}><path d="M1077.921875-364.457031 1738.515625 777.484375 748.484375 1350.199219 87.890625 208.257812Z" /></clipPath>
        <clipPath id={`${id}-outer-b`}><path d="M1059.941406-318.34375 1690.71875 772.058594 734.109375 1325.4375 103.332031 235.039062Z" /></clipPath>
        <clipPath id={`${id}-outer-shape`}>
          <path d="M1370.710938 271.394531 787.527344 1283.964844C779.808594 1297.371094 765.523438 1305.636719 750.054688 1305.652344 734.585938 1305.667969 720.285156 1297.425781 712.539062 1284.039062L127.191406 272.167969C119.445312 258.777344 119.433594 242.273438 127.15625 228.871094 134.882812 215.472656 149.167969 207.207031 164.636719 207.199219L1333.140625 206.453125C1348.613281 206.441406 1362.917969 214.6875 1370.667969 228.082031 1378.417969 241.476562 1378.433594 257.984375 1370.710938 271.394531Z" />
        </clipPath>
        <clipPath id={`${id}-monogram`}><path d="M262 327.066406H1238V1173H262Z" /></clipPath>
      </defs>
      <path
        fill="var(--brand-logo-bg)"
        d="M1370.722656 271.390625 787.539062 1283.96875C779.816406 1297.371094 765.53125 1305.636719 750.066406 1305.652344 734.597656 1305.667969 720.296875 1297.429688 712.550781 1284.039062L127.199219 272.164062C119.453125 258.773438 119.441406 242.269531 127.164062 228.867188 134.886719 215.46875 149.175781 207.203125 164.644531 207.195312L1333.152344 206.449219C1348.628906 206.4375 1362.933594 214.683594 1370.679688 228.078125 1378.429688 241.472656 1378.445312 257.980469 1370.722656 271.390625Z"
      />
      <g clipPath={clip('canvas')}><g clipPath={clip('outer-a')}><g clipPath={clip('outer-b')}><g clipPath={clip('outer-shape')}>
        <path
          d="M929.338646 86.607722 1708.621124 1435.718646C1718.940351 1453.577752 1718.94257 1475.583259 1708.632955 1493.446713 1698.323341 1511.310168 1679.262887 1522.312334 1658.641161 1522.314782L100.000545 1522.313263C79.374311 1522.313103 60.318754 1511.307862 50.006643 1493.446856 39.701648 1475.583949 39.699429 1453.578442 50.01806 1435.720204L829.303843 86.611061C839.620574 68.745707 858.688144 57.74164 879.321495 57.739899 899.954845 57.738159 919.017518 68.7415 929.338646 86.607722Z"
          transform="matrix(.375551 .649201 -.649201 .375551 1077.922909 -364.458329)"
          stroke={color}
          strokeWidth="50"
        />
      </g></g></g></g>
      <path
        fill={color}
        clipPath={clip('monogram')}
        d="M750.605469 1172.925781 262.246094 327.066406 359.960938 327.140625 750.605469 1003.726562 799.445312 919.125 457.640625 327.101562 555.28125 327.140625 897.125 919.160156ZM944.746094 834.5625 651.742188 327.101562H944.746094L993.550781 411.667969 944.746094 496.269531H1042.351562L1091.191406 580.867188ZM847.101562 496.269531 895.941406 411.667969H798.261719ZM895.90625 580.832031 944.746094 665.398438 993.550781 580.832031ZM1140.066406 496.269531 1237.746094 327.101562V327.066406L1042.386719 327.101562Z"
      />
    </svg>
  )
}
