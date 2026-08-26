import type { JSX, ReactNode } from 'react'
import { Icon } from '../Icon/Icon'
import styles from './TitleBar.module.css'

export interface TitleBarProps {
  /** "Wrightbench", "Wrightbench — web-app", "Wrightbench — Settings" */
  title?: string
  /** import/detection flows drop the whole right cluster */
  variant?: 'full' | 'quiet'
  /** welcome keeps the native drag region without drawing a divider */
  borderless?: boolean
  /**
   * Inside Electron macOS draws the real traffic lights (hiddenInset), so we
   * only reserve their space; in a plain-browser preview we draw the dots.
   */
  fauxTrafficLights?: boolean
  sidebarCollapsed?: boolean
  onSidebarToggle?: () => void
  /** global workspace scope control rendered after the macOS window controls */
  projectControl?: ReactNode
  /** direct workspace destination navigation; active clicks are intentionally idempotent */
  activeDestination?: 'record' | 'ui-mode' | 'reports'
  onRecordClick?: () => void
  onUiModeClick?: () => void
  onReportsClick?: () => void
  settingsActive?: boolean
  onSettingsClick?: () => void
  /** contextual controls owned by the active global surface */
  sessionControls?: ReactNode
}

export function TitleBar({
  title = 'Wrightbench',
  variant = 'full',
  borderless = false,
  fauxTrafficLights = typeof window !== 'undefined' && !window.wrightbench,
  sidebarCollapsed = false,
  onSidebarToggle,
  projectControl,
  activeDestination,
  onRecordClick,
  onUiModeClick,
  onReportsClick,
  settingsActive = false,
  onSettingsClick,
  sessionControls,
}: TitleBarProps): JSX.Element {
  return (
    <div
      className={`${styles.bar}${variant === 'full' ? ` ${styles.barFull}` : ''}${borderless ? ` ${styles.borderless}` : ''}`}
    >
      <div className={styles.left}>
        {fauxTrafficLights ? (
          <div className={styles.lights} aria-hidden>
            <span className={`${styles.light} ${styles.close}`} />
            <span className={`${styles.light} ${styles.minimize}`} />
            <span className={`${styles.light} ${styles.zoom}`} />
          </div>
        ) : (
          <div className={styles.lightsSpacer} aria-hidden />
        )}
        {variant === 'full' && projectControl}
      </div>
      {variant === 'full' && (onRecordClick || onUiModeClick || onReportsClick) ? (
        <nav className={styles.primaryNav} aria-label="Workspace destinations">
          {onRecordClick && (
            <button
              type="button"
              className={
                activeDestination === 'record'
                  ? `${styles.primaryNavButton} ${styles.primaryNavButtonActive}`
                  : styles.primaryNavButton
              }
              aria-current={activeDestination === 'record' ? 'page' : undefined}
              onClick={onRecordClick}
            >
              <Icon name="record" size={11} />
              Record
            </button>
          )}
          {onUiModeClick && (
            <button
              type="button"
              className={
                activeDestination === 'ui-mode'
                  ? `${styles.primaryNavButton} ${styles.primaryNavButtonActive}`
                  : styles.primaryNavButton
              }
              aria-current={activeDestination === 'ui-mode' ? 'page' : undefined}
              onClick={onUiModeClick}
            >
              <Icon name="play" size={11} />
              Run
            </button>
          )}
          {onReportsClick && (
            <button
              type="button"
              className={
                activeDestination === 'reports'
                  ? `${styles.primaryNavButton} ${styles.primaryNavButtonActive}`
                  : styles.primaryNavButton
              }
              aria-current={activeDestination === 'reports' ? 'page' : undefined}
              onClick={onReportsClick}
            >
              <Icon name="file" size={12} />
              Report
            </button>
          )}
        </nav>
      ) : (
        <div className={styles.title}>{title}</div>
      )}
      {variant === 'full' ? (
        <div className={styles.right}>
          {onSidebarToggle && (
            <button
              type="button"
              className={styles.sidebarToggle}
              onClick={onSidebarToggle}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}B)`}
            >
              <Icon name="sidebar" size={15} />
            </button>
          )}
          {sessionControls}
          {onSettingsClick && (
            <button
              type="button"
              className={
                settingsActive
                  ? `${styles.settingsButton} ${styles.settingsButtonActive}`
                  : styles.settingsButton
              }
              aria-pressed={settingsActive}
              aria-label={settingsActive ? 'Close Settings' : 'Open Settings'}
              onClick={onSettingsClick}
              title={settingsActive ? 'Close Settings' : 'Settings'}
            >
              <Icon name="sliders" size={14} />
            </button>
          )}
        </div>
      ) : (
        <div />
      )}
    </div>
  )
}
