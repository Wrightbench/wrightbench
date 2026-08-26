import type { CSSProperties, InputHTMLAttributes, JSX, ReactNode } from 'react'
import { Icon, type IconName } from '../Icon/Icon'
import styles from './Input.module.css'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'width' | 'style'> {
  /** URL bar is 32px; toolbar inputs 30px; sidebar filter 26px */
  size?: 26 | 30 | 32
  /** exact horizontal padding from the reference (grep 11, filter 10, URL 12) */
  padX?: number
  /** gap between icon / field / trailing (grep 6, filter 7, URL 8) */
  gap?: number
  surface?: 'card' | 'panel'
  mono?: boolean
  fontSize?: number
  icon?: IconName
  iconSize?: number
  /** fixed content width (reference is content-box, so padding adds outside) */
  width?: number
  /** stretch to fill the row */
  grow?: boolean
  /** right-aligned addon (e.g. the "connected" indicator) */
  trailing?: ReactNode
  dimmed?: boolean
  style?: CSSProperties
}

export function Input({
  size = 30,
  padX = 11,
  gap = 6,
  surface = 'card',
  mono,
  fontSize,
  icon,
  iconSize = 12,
  width,
  grow,
  trailing,
  dimmed,
  style,
  className,
  ...rest
}: InputProps): JSX.Element {
  const classes = [
    styles.wrap,
    styles[`h${size}`],
    styles[surface],
    grow ? styles.grow : '',
    dimmed ? styles.dimmed : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const fieldClasses = [styles.field, mono ? styles.mono : ''].filter(Boolean).join(' ')
  const resolvedFontSize = fontSize ?? (mono ? 12 : 12.5)

  return (
    <span
      className={classes}
      style={{
        ...style,
        padding: `0 ${padX}px`,
        gap,
        ...(width !== undefined && { width })
      }}
    >
      {icon && (
        <span className={styles.icon}>
          <Icon name={icon} size={iconSize} />
        </span>
      )}
      <input className={fieldClasses} style={{ fontSize: resolvedFontSize }} {...rest} />
      {trailing}
    </span>
  )
}
