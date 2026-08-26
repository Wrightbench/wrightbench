import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import { Button } from '../Button/Button'
import styles from './ConfirmDialog.module.css'

export interface ConfirmDialogProps {
  title: string
  body: string
  /** mono detail line under the body (a path, a hash) */
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  /** destructive confirm renders the danger button treatment */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** kitchen-sink embedding: overlay fills the nearest positioned ancestor */
  embedded?: boolean
}

/**
 * Minimal modal confirmation. Focus starts on Cancel (the safe action),
 * Tab cycles inside the dialog, Escape and scrim-click cancel.
 */
export function ConfirmDialog({
  title,
  body,
  detail,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
  embedded
}: ConfirmDialogProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // focus starts on Cancel — the safe action (not in static sink previews)
    if (!embedded) cardRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [embedded])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key !== 'Tab') return
    // two-stop focus trap: keep Tab inside the dialog's buttons
    const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const next = e.shiftKey
      ? (index - 1 + buttons.length) % buttons.length
      : (index + 1) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div
      className={embedded ? `${styles.overlay} ${styles.embedded}` : styles.overlay}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={styles.card}
      >
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>{body}</div>
        {detail !== undefined && <div className={styles.detail}>{detail}</div>}
        <div className={styles.actions}>
          <Button variant="ghost" muted size={32} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size={32} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
