import type { ButtonHTMLAttributes, JSX } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'danger-outline' | 'pill' | 'link'
export type ButtonSize = 38 | 34 | 32 | 30 | 26

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** hero ghost + "New profile" sit directly on --bg/card with no fill */
  transparent?: boolean
  /** secondary-text buttons (Cancel, New profile, Pick locator) */
  muted?: boolean
  /** one-off horizontal padding overrides where the reference deviates */
  padX?: number
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.primary,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-outline': styles.dangerOutline,
  pill: styles.pill,
  link: styles.link
}

export function Button({
  variant = 'ghost',
  size = 32,
  transparent,
  muted,
  padX,
  className,
  style,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    styles.btn,
    styles[`h${size}`],
    VARIANT_CLASS[variant],
    transparent ? styles.transparent : '',
    muted ? styles.muted : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const mergedStyle =
    padX !== undefined ? { ...style, paddingLeft: padX, paddingRight: padX } : style

  return (
    <button type="button" className={classes} style={mergedStyle} {...rest}>
      {children}
    </button>
  )
}
