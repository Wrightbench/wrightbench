import { useState, type JSX, type ReactNode } from 'react'
import { Button } from '../components/Button/Button'
import { Chip } from '../components/Chip/Chip'
import { ConfirmDialog } from '../components/ConfirmDialog/ConfirmDialog'
import { ContextMenu } from '../components/ContextMenu/ContextMenu'
import {
  ALL_DATE_RANGE,
  DateRangePicker,
  type DateRangeValue
} from '../components/DateRangePicker/DateRangePicker'
import { Icon, LogoMark, type IconName } from '../components/Icon/Icon'
import { Input } from '../components/Input/Input'
import { Select } from '../components/Select/Select'
import { SegmentedControl } from '../components/SegmentedControl/SegmentedControl'
import {
  StatusBar,
  StatusBarElapsed,
  StatusBarFailed,
  StatusBarItem,
  StatusBarProgress
} from '../components/StatusBar/StatusBar'
import { Spinner, StatusDot } from '../components/StatusDot/StatusDot'
import { Tabs } from '../components/Tabs/Tabs'
import { TitleBar } from '../components/TitleBar/TitleBar'
import { TogglePill } from '../components/TogglePill/TogglePill'
import { FrameAction, WebviewFrame } from '../components/WebviewFrame/WebviewFrame'
import { useTheme } from '../state/theme'
import styles from './KitchenSink.module.css'

const MAIN_TABS = ['Tests', 'UI Mode', 'Runs', 'Codegen'] as const

const ICON_NAMES: IconName[] = [
  'search',
  'gear',
  'sliders',
  'ellipsis',
  'folder',
  'plus',
  'upload',
  'download',
  'sidebar',
  'chevron-left',
  'chevron-right',
  'chevron-down-tree',
  'chevron-down',
  'grid',
  'list',
  'expand',
  'collapse',
  'check',
  'warning',
  'filter',
  'play',
  'stop',
  'record',
  'rotate-cw',
  'eye',
  'clock',
  'calendar',
  'external-link',
  'copy',
  'x',
  'file',
  'image',
  'video',
  'pause',
  'globe',
  'cursor',
  'save',
  'pencil',
  'sun',
  'moon',
  'monitor'
]

function Section({
  title,
  flush,
  children
}: {
  title: string
  /** render panels without body padding (full-bleed demos like TitleBar) */
  flush?: boolean
  children: (theme: 'light' | 'dark') => ReactNode
}): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.panels}>
        {(['light', 'dark'] as const).map((theme) => (
          <div key={theme} className={styles.panel} data-theme={theme}>
            <div className={flush ? styles.panelBodyFlush : styles.panelBody}>
              {children(theme)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ label, children }: { label?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={styles.row}>
      {label && <span className={styles.label}>{label}</span>}
      {children}
    </div>
  )
}

export default function KitchenSink(): JSX.Element {
  const { preference, setPreference } = useTheme()
  const [tab, setTab] = useState<(typeof MAIN_TABS)[number]>('Tests')
  const [watch, setWatch] = useState(false)
  const [snapshot, setSnapshot] = useState('after')
  const [density, setDensity] = useState('relaxed')
  const [dateRange, setDateRange] = useState<DateRangeValue>(ALL_DATE_RANGE)

  return (
    <div className={styles.sink}>
      <div className={styles.header}>
        <span className={styles.h1}>Kitchen sink</span>
        <span className={styles.note}>every primitive, both themes — Phase 0</span>
        <div className={styles.themeSwitch}>
          <SegmentedControl
            variant="pill"
            segments={[
              { value: 'light', label: 'Light', icon: 'sun' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
              { value: 'system', label: 'System', icon: 'monitor' }
            ]}
            value={preference}
            onChange={(v) => setPreference(v)}
          />
        </div>
      </div>

      <Section title="TITLE BAR" flush>
        {() => (
          <>
            <TitleBar
              title="Wrightbench"
              fauxTrafficLights
              sidebarCollapsed={false}
              onSidebarToggle={() => {}}
              projectControl={
                <Button variant="ghost" size={30} padX={9} transparent>
                  <Icon name="folder" size={12} />
                  web-app
                  <Icon name="chevron-down" size={10} />
                </Button>
              }
              activeDestination="reports"
              onUiModeClick={() => {}}
              onReportsClick={() => {}}
              onSettingsClick={() => {}}
            />
            <TitleBar
              title="Wrightbench"
              fauxTrafficLights
              projectControl={
                <Button variant="ghost" size={30} padX={9} transparent>
                  <Icon name="folder" size={12} />
                  web-app
                  <Icon name="chevron-down" size={10} />
                </Button>
              }
              activeDestination="ui-mode"
              onUiModeClick={() => {}}
              onReportsClick={() => {}}
              settingsActive
              onSettingsClick={() => {}}
            />
          </>
        )}
      </Section>

      <Section title="BUTTONS">
        {() => (
          <>
            <Row label="hero 38">
              <Button variant="primary" size={38}>
                <Icon name="folder" size={14} />
                Add a project…
              </Button>
              <Button variant="ghost" size={38} transparent>
                <Icon name="plus" size={14} />
                Create a new Playwright project…
              </Button>
            </Row>
            <Row label="modal 34">
              <Button variant="ghost" size={34} muted>
                Cancel
              </Button>
              <Button variant="primary" size={34}>
                Add web-app to Wrightbench
              </Button>
            </Row>
            <Row label="toolbar 32">
              <Button variant="primary" size={32}>
                <Icon name="play" size={12} />
                Run all
              </Button>
              <Button variant="ghost" size={32}>
                <Icon name="rotate-cw" size={13} color="var(--fail)" />
                Re-run failed
              </Button>
              <Button variant="primary" size={32} padX={16}>
                <Icon name="save" size={12} />
                Save to spec file
              </Button>
              <Button variant="ghost" size={32} disabled>
                <Icon name="rotate-cw" size={13} color="var(--fail)" />
                Re-run failed
              </Button>
            </Row>
            <Row label="danger">
              <Button variant="danger-outline" size={32}>
                <Icon name="stop" size={11} />
                Stop run
              </Button>
              <Button variant="danger" size={32} padX={14}>
                <span className={styles.dot9fail} aria-hidden />
                Stop recording
              </Button>
            </Row>
            <Row label="actions 30">
              <Button variant="primary" size={30}>
                <Icon name="rotate-cw" size={12} />
                Re-run this test
              </Button>
              <Button variant="ghost" size={30}>
                <Icon name="external-link" size={12} />
                Open in Trace Viewer
              </Button>
              <Button variant="ghost" size={30}>
                <Icon name="copy" size={12} />
                Copy failing locator
              </Button>
              <Button variant="ghost" size={30} muted padX={12} style={{ fontWeight: 400 }}>
                <Icon name="cursor" size={13} />
                Pick locator
              </Button>
            </Row>
            <Row label="pills · link">
              <Button variant="pill" size={26}>
                <Icon name="download" size={12} />
                Install browsers
              </Button>
              <Button variant="ghost" size={32} transparent muted padX={14}>
                <Icon name="plus" size={12} />
                New profile
              </Button>
              <Button variant="link">Clear old artifacts</Button>
              <TogglePill icon="eye" active={watch} onClick={() => setWatch(!watch)}>
                Watch
              </TogglePill>
            </Row>
          </>
        )}
      </Section>

      <Section title="CHIPS & PILLS">
        {() => (
          <>
            <Row label="result">
              <Chip tone="pass">121 pass</Chip>
              <Chip tone="fail">5 fail</Chip>
              <Chip tone="flaky">2 flaky</Chip>
            </Row>
            <Row label="caps · sm">
              <Chip tone="fail" variant="caps">
                FAILED
              </Chip>
              <Chip tone="fail" variant="sm">
                FAILED
              </Chip>
              <Chip tone="flaky" variant="sm">
                FLAKY
              </Chip>
              <Chip tone="accent" variant="tag">
                DEFAULT
              </Chip>
            </Row>
            <Row label="composite">
              <span className={styles.detected}>
                <Icon name="check" size={12} />
                Playwright project detected
              </span>
              <span className={styles.recording}>
                <span className={styles.dot7fail} aria-hidden />
                Recording · 0:42
              </span>
              <span className={styles.connected}>
                <span className={styles.dot6pass} aria-hidden />
                connected
              </span>
            </Row>
          </>
        )}
      </Section>

      <Section title="STATUS DOTS">
        {() => (
          <Row>
            <Row label="pass">
              <StatusDot status="pass" />
            </Row>
            <Row label="fail">
              <StatusDot status="fail" />
            </Row>
            <Row label="flaky">
              <StatusDot status="flaky" />
            </Row>
            <Row label="queued">
              <StatusDot status="queued" />
            </Row>
            <Row label="running 12 · 11">
              <Spinner size={12} />
              <Spinner size={11} />
            </Row>
          </Row>
        )}
      </Section>

      <Section title="CONFIRM DIALOG">
        {() => (
          <div style={{ position: 'relative', minHeight: 240 }}>
            <ConfirmDialog
              embedded
              danger
              title="Remove “web-app” from Wrightbench?"
              body="The project’s files will not be changed. Existing run history will be preserved."
              detail="~/dev/acme/web-app"
              confirmLabel="Remove from Wrightbench"
              onConfirm={() => {}}
              onCancel={() => {}}
            />
          </div>
        )}
      </Section>

      <Section title="SELECTS & INPUTS">
        {() => (
          <>
            <Row label="toolbar">
              <Select options={['staging', 'production']} value="staging" aria-label="Environment" />
              <Select options={['chromium', 'firefox', 'webkit']} value="chromium" aria-label="Browser" />
              <Input
                mono
                icon="search"
                width={170}
                placeholder="--grep @checkout"
                aria-label="grep filter"
              />
              <Select options={['4 workers', '2 workers', '1 worker']} value="4 workers" muted aria-label="Workers" />
            </Row>
            <Row label="dimmed .55">
              <Select options={['staging']} value="staging" dimmed aria-label="Environment (disabled during run)" />
              <Select options={['chromium']} value="chromium" dimmed aria-label="Browser (disabled during run)" />
            </Row>
            <div className={styles.demoCard}>
              <span className={styles.label}>on card</span>
              <Select options={['90 days', '30 days', '14 days']} value="90 days" size={28} surface="panel" aria-label="Run retention" />
              <Select options={['14 days', '7 days']} value="14 days" size={28} surface="panel" aria-label="Artifact retention" />
              <Select
                options={['JetBrains Mono', 'SF Mono', 'Fira Code']}
                value="JetBrains Mono"
                size={28}
                surface="panel"
                mono
                aria-label="Code font"
              />
              <Select
                options={[
                  { value: '1.62.1', label: '1.62.1 · Latest verified', group: 'Verified' },
                  { value: '1.61.1', group: 'Verified' },
                  { value: 'next', label: 'npm next', group: 'Experimental' }
                ]}
                value="1.62.1"
                size={28}
                surface="panel"
                mono
                aria-label="Playwright version"
              />
              <Input
                surface="panel"
                mono
                fontSize={11.5}
                width={280}
                padX={10}
                placeholder="/usr/local/bin/node"
                aria-label="fixed node path"
              />
            </div>
            <Row label="url bar 32">
              <Input
                size={32}
                grow
                padX={12}
                gap={8}
                icon="globe"
                iconSize={13}
                mono
                fontSize={12.5}
                defaultValue="https://staging.acme.shop/checkout"
                aria-label="codegen url"
                trailing={
                  <span className={styles.connected}>
                    <span className={styles.dot6pass} aria-hidden />
                    connected
                  </span>
                }
              />
            </Row>
            <Row label="text 30">
              <Input
                icon="search"
                padX={10}
                gap={7}
                fontSize={12}
                grow
                placeholder="Filter traces"
                aria-label="filter traces"
              />
              <Input mono grow defaultValue="guest applies gift card" aria-label="test name" />
            </Row>
            <Row label="filter 26">
              <Input
                icon="search"
                iconSize={11}
                size={26}
                padX={9}
                gap={7}
                fontSize={12}
                grow
                placeholder="Filter tests…"
                aria-label="filter tests"
              />
            </Row>
          </>
        )}
      </Section>

      <Section title="DATE RANGE">
        {() => (
          <div style={{ minHeight: 455 }}>
            <Row label="runs">
              <DateRangePicker
                value={dateRange}
                onChange={setDateRange}
                minDate={Date.now() - 1000 * 60 * 60 * 24 * 180}
                compact
                align="start"
              />
            </Row>
          </div>
        )}
      </Section>

      <Section title="TABS" flush>
        {(theme) => (
          <>
            <Tabs
              tabs={MAIN_TABS}
              active={tab}
              onChange={setTab}
              trailing={
                <span style={{ padding: '8px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Select
                    options={['Last 30 runs', 'Last 90 runs']}
                    value="Last 30 runs"
                    size={28}
                    muted
                    aria-label="Reports range"
                  />
                </span>
              }
            />
            <Tabs
              tabs={MAIN_TABS}
              active={theme === 'light' ? 'Codegen' : 'UI Mode'}
              trailing={
                <span className={styles.recording} style={{ marginBottom: 9 }}>
                  <span className={styles.dot7fail} aria-hidden />
                  Recording · 0:42
                </span>
              }
            />
            <Tabs
              tabs={MAIN_TABS}
              active="Tests"
              leading={
                <Button variant="ghost" size={26} padX={5} aria-label="Collapse sidebar">
                  <Icon name="chevron-left" size={12} />
                </Button>
              }
            />
          </>
        )}
      </Section>

      <Section title="CONTEXT MENU">
        {() => (
          <ContextMenu
            embedded
            label="Menu states"
            entries={[
              { label: 'All tests', checked: true, onSelect: () => {} },
              { label: 'Failed', checked: false, onSelect: () => {} },
              'separator',
              { label: 'Re-run test', icon: 'rotate-cw', onSelect: () => {} },
              { label: 'Open latest trace', icon: 'eye', onSelect: () => {} },
              'separator',
              { label: 'Open file', icon: 'file', onSelect: () => {} },
              { label: 'Copy test location', icon: 'copy', onSelect: () => {} },
              'separator',
              {
                label: 'Remove from Wrightbench',
                icon: 'x',
                danger: true,
                disabled: true,
                title: 'Stop the active session first',
                onSelect: () => {}
              }
            ]}
            onClose={() => {}}
          />
        )}
      </Section>

      <Section title="SEGMENTED CONTROLS">
        {(theme) => (
          <>
            <Row label="rect">
              <SegmentedControl
                variant="rect"
                segments={[
                  { value: 'before', label: 'Before' },
                  { value: 'after', label: 'After' },
                  { value: 'diff', label: 'Diff' }
                ]}
                value={snapshot}
                onChange={setSnapshot}
              />
            </Row>
            <Row label="pill">
              <SegmentedControl
                variant="pill"
                segments={[
                  { value: 'light', label: 'Light', icon: 'sun' },
                  { value: 'dark', label: 'Dark', icon: 'moon' },
                  { value: 'system', label: 'System', icon: 'monitor' }
                ]}
                value={theme}
              />
              <SegmentedControl
                variant="pill"
                segments={[
                  { value: 'relaxed', label: 'Relaxed' },
                  { value: 'compact', label: 'Compact' }
                ]}
                value={density}
                onChange={setDensity}
              />
            </Row>
          </>
        )}
      </Section>

      <Section title="WEBVIEW FRAME — native light/dark">
        {() => (
          <div className={styles.frameDemo}>
            <WebviewFrame
              label="embedded UI Mode"
              followDot
              actions={
                <FrameAction title="Enlarge">
                  <Icon name="expand" size={12} />
                </FrameAction>
              }
            >
              <div className={styles.wvBody}>
                <div className={styles.wvPanel}>
                  <span className={styles.wvBone} />
                  <span className={styles.wvBoneThin} />
                  <span className={styles.wvBoneThin} style={{ width: '52%' }} />
                </div>
              </div>
            </WebviewFrame>
          </div>
        )}
      </Section>

      <Section title="STATUS BAR" flush>
        {() => (
          <>
            <StatusBar mono="Node v20.12.2 · Playwright v1.62.1">
              <StatusBarItem>
                <StatusDot status="pass" />
                UI Mode ready
              </StatusBarItem>
              <span>Runs save to Reports</span>
            </StatusBar>
            <StatusBar running mono="Node v20.12.2 · Playwright v1.62.1">
              <StatusBarItem>
                <Spinner size={11} />
                Running 33 / 128
              </StatusBarItem>
              <StatusBarProgress percent={26} />
              <StatusBarFailed>2 failed so far</StatusBarFailed>
              <StatusBarElapsed>elapsed 0:58</StatusBarElapsed>
            </StatusBar>
          </>
        )}
      </Section>

      <Section title="ICONS — 1.5px stroke, round caps">
        {() => (
          <div className={styles.iconGrid}>
            {ICON_NAMES.map((name) => (
              <span key={name} className={styles.iconCell}>
                <Icon name={name} size={14} color="var(--t2)" />
                {name}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="TYPOGRAPHY & LOGO">
        {() => (
          <>
            <LogoMark />
            <div className={styles.serifHeadline}>A calm home for your Playwright tests.</div>
            <div>Base UI — Schibsted Grotesk 13.5px/1.5</div>
            <div className={styles.monoSample}>tests/e2e/checkout.spec.ts · 7f3a2c1 · 3m 42s</div>
            <div className={styles.microLabel}>PROJECTS</div>
          </>
        )}
      </Section>
    </div>
  )
}
