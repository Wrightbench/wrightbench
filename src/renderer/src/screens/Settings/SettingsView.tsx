import { useEffect, type JSX } from 'react'
import { Icon } from '@/components/Icon/Icon'
import { SegmentedControl } from '@/components/SegmentedControl/SegmentedControl'
import { Select } from '@/components/Select/Select'
import { StatusBar } from '@/components/StatusBar/StatusBar'
import { useSettings } from '@/state/settings'
import { useTheme } from '@/state/theme'
import type { CaptureMode, ThemePreference } from '@shared/ipc'
import styles from './SettingsView.module.css'

const THEME_SEGMENTS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' }
] as const

const DENSITY_SEGMENTS = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'compact', label: 'Compact' }
] as const

const CODE_FONTS = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'sf-mono', label: 'SF Mono' },
  { value: 'menlo', label: 'Menlo' }
]

function formatGb(bytes: number): string {
  if (bytes === 0) return '0 KB'
  // the reference sticks to GB down to tenths ("videos 0.5 GB")
  if (bytes >= 0.1 * 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function SettingsView({
  onClose,
  returnTo = 'workspace'
}: {
  onClose?: () => void
  returnTo?: 'Record' | 'Run' | 'Report' | 'workspace'
} = {}): JSX.Element {
  const settings = useSettings((s) => s.settings)
  const storage = useSettings((s) => s.storage)
  const nodeInfo = useSettings((s) => s.nodeInfo)
  const clearedNote = useSettings((s) => s.clearedNote)
  const load = useSettings((s) => s.load)
  const update = useSettings((s) => s.update)
  const themePreference = useTheme((s) => s.preference)
  const setThemePreference = useTheme((s) => s.setPreference)

  useEffect(() => {
    void load()
  }, [load])

  const overlayHeader = onClose ? (
    <header className={styles.overlayHeader}>
      <span className={styles.overlayTitle}>
        <Icon name="sliders" size={14} />
        Settings
      </span>
      <button type="button" className={styles.backButton} onClick={onClose}>
        <Icon name="chevron-left" size={12} />
        Back to {returnTo}
      </button>
    </header>
  ) : null

  if (!settings) {
    return (
      <div className={styles.root}>
        {overlayHeader}
        <div className={styles.loading}>Loading settings…</div>
      </div>
    )
  }

  const totalBytes = (storage?.artifactBytes ?? 0) + (storage?.dbBytes ?? 0)
  const meterPct = Math.min(100, (totalBytes / (settings.artifactBudgetGb * 1024 ** 3)) * 100)
  const captureCaption =
    settings.captureMode === 'full'
      ? 'Records a trace, screenshot and video for every browser test attempt.'
      : settings.captureMode === 'balanced'
        ? 'Full traces for focused tests; suite failures retain trace evidence.'
        : 'Failure traces are retained; project-reported attachments are preserved.'

  return (
    <div className={styles.root}>
      {overlayHeader}
      <div className={styles.body}>
        <div className={styles.content}>
          <div className={styles.colLeft}>
            <section>
              <div className={styles.sectionTitle}>Node runtime</div>
              <div className={styles.sectionSub}>
                How Wrightbench resolves the Node binary used to run Playwright.
              </div>
              <div className={styles.card}>
                <button
                  type="button"
                  className={`${styles.radioRow} ${styles.radioRowBordered}`}
                  onClick={() => void update({ nodeMode: 'auto' })}
                >
                  <span
                    className={
                      settings.nodeMode === 'auto' ? styles.radioOn : styles.radioOff
                    }
                  />
                  <span className={styles.radioBody}>
                    <span className={styles.radioLabel}>Auto-detect per project</span>
                    <span className={styles.radioDesc}>
                      Reads <span className={styles.inlineMono}>.nvmrc</span> /{' '}
                      <span className={styles.inlineMono}>.node-version</span>, falls back to PATH
                    </span>
                    {nodeInfo?.autoPath && (
                      <span className={styles.resolvedPill}>
                        <span className={styles.resolvedDot} />
                        {nodeInfo.autoPath}
                      </span>
                    )}
                  </span>
                </button>
                <div className={styles.radioRow}>
                  <button
                    type="button"
                    className={styles.radioHit}
                    onClick={() => void update({ nodeMode: 'fixed' })}
                    aria-label="Use a fixed path"
                  >
                    <span
                      className={
                        settings.nodeMode === 'fixed' ? styles.radioOn : styles.radioOff
                      }
                    />
                    <span
                      className={
                        settings.nodeMode === 'fixed'
                          ? styles.radioLabel
                          : `${styles.radioLabel} ${styles.radioLabelMuted}`
                      }
                    >
                      Use a fixed path
                    </span>
                  </button>
                  <input
                    className={styles.pathInput}
                    value={settings.nodePath}
                    placeholder="/usr/local/bin/node"
                    spellCheck={false}
                    disabled={settings.nodeMode !== 'fixed'}
                    onChange={(e) => void update({ nodePath: e.target.value })}
                    aria-label="Fixed node path"
                  />
                </div>
              </div>
            </section>

            <section>
              <div className={styles.sectionTitle}>Appearance</div>
              <div className={styles.sectionSub}>Theme follows this setting across every window.</div>
              <div className={styles.card}>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>Theme</span>
                  <SegmentedControl
                    segments={THEME_SEGMENTS}
                    value={themePreference}
                    onChange={(v) => setThemePreference(v as ThemePreference)}
                    variant="pill"
                  />
                </div>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>Code font</span>
                  <Select
                    options={CODE_FONTS}
                    value={settings.codeFont}
                    onChange={(v) => void update({ codeFont: v as typeof settings.codeFont })}
                    size={28}
                    surface="panel"
                    mono
                    aria-label="Code font"
                  />
                </div>
                <div className={styles.settingRow}>
                  <span>
                    Density
                    <span className={styles.settingCaption}>Tables and test trees only</span>
                  </span>
                  <SegmentedControl
                    segments={DENSITY_SEGMENTS}
                    value={settings.density}
                    onChange={(v) => void update({ density: v as typeof settings.density })}
                    variant="pill"
                  />
                </div>
              </div>
            </section>
          </div>

          <div className={styles.colRight}>
            <section>
              <div className={styles.sectionTitle}>Run history &amp; storage</div>
              <div className={styles.sectionSub}>Runs, traces and videos are stored locally.</div>
              <div className={styles.card}>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>
                    Capture policy
                    <span className={styles.settingCaption}>{captureCaption}</span>
                  </span>
                  <Select
                    options={[
                      { value: 'full', label: 'Full evidence' },
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'failures', label: 'Failure evidence' }
                    ]}
                    value={settings.captureMode}
                    onChange={(v) => void update({ captureMode: v as CaptureMode })}
                    size={28}
                    surface="panel"
                    aria-label="Run evidence capture policy"
                  />
                </div>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>Keep run history</span>
                  <Select
                    options={[
                      { value: '30', label: '30 days' },
                      { value: '90', label: '90 days' },
                      { value: '180', label: '180 days' }
                    ]}
                    value={String(settings.runRetentionDays)}
                    onChange={(v) => void update({ runRetentionDays: Number(v) })}
                    size={28}
                    surface="panel"
                    aria-label="Run history retention"
                  />
                </div>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>
                    Keep detailed evidence
                    <span className={styles.settingCaption}>Traces, screenshots, videos and reports</span>
                  </span>
                  <Select
                    options={[
                      { value: '7', label: '7 days' },
                      { value: '14', label: '14 days' },
                      { value: '30', label: '30 days' }
                    ]}
                    value={String(settings.traceRetentionDays)}
                    onChange={(v) => void update({ traceRetentionDays: Number(v) })}
                    size={28}
                    surface="panel"
                    aria-label="Trace retention"
                  />
                </div>
                <div className={`${styles.settingRow} ${styles.settingRowBordered}`}>
                  <span>
                    Artifact disk budget
                    <span className={styles.settingCaption}>Oldest detailed evidence is pruned first</span>
                  </span>
                  <Select
                    options={[
                      { value: '1', label: '1 GB' },
                      { value: '2', label: '2 GB' },
                      { value: '5', label: '5 GB' },
                      { value: '10', label: '10 GB' },
                      { value: '20', label: '20 GB' }
                    ]}
                    value={String(settings.artifactBudgetGb)}
                    onChange={(v) => void update({ artifactBudgetGb: Number(v) })}
                    size={28}
                    surface="panel"
                    aria-label="Artifact disk budget"
                  />
                </div>
                <div className={styles.storageBlock}>
                  <div className={styles.storageHeader}>
                    <span>Storage used</span>
                    <span className={styles.storageValue}>
                      {formatGb(totalBytes)} / {settings.artifactBudgetGb} GB
                    </span>
                  </div>
                  <div className={styles.meter}>
                    <span className={styles.meterFill} style={{ width: `${meterPct}%` }} />
                  </div>
                  <div className={styles.storageCaption}>
                    <span className={styles.storageBreakdown}>
                      {storage
                        ? `traces ${formatGb(storage.traceBytes)} · videos ${formatGb(storage.videoBytes)} · runs ${formatGb(storage.otherBytes + storage.dbBytes)}`
                        : 'measuring…'}
                    </span>
                    <button
                      type="button"
                      className={styles.textLink}
                      onClick={() => void useSettings.getState().clearArtifacts()}
                    >
                      Clear old artifacts
                    </button>
                  </div>
                  {clearedNote !== null && <div className={styles.clearedNote}>{clearedNote}</div>}
                </div>
              </div>
            </section>

          </div>
        </div>
      </div>

      <StatusBar mono={`Wrightbench ${__APP_VERSION__}`}>
        <span>Changes save automatically</span>
      </StatusBar>
    </div>
  )
}
