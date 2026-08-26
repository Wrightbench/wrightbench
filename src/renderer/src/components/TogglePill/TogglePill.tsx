import type { ButtonHTMLAttributes, JSX } from 'react'
import { Icon, type IconName } from '../Icon/Icon'
import styles from './TogglePill.module.css'

export interface TogglePillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  icon?: IconName
  iconSize?: number
}

/** The Watch pill: 999px toggle, transparent when off, accent-tinted when on. */
export function TogglePill({
  active,
  icon,
  iconSize = 13,
  className,
  children,
  ...rest
}: TogglePillProps): JSX.Element {
  const classes = [styles.pill, active ? styles.active : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" aria-pressed={active} className={classes} {...rest}>
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
    </button>
  )
}
