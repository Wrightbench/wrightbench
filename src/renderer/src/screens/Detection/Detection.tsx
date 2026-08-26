import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { Select } from '@/components/Select/Select'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import { radioNavigationIndex } from '@/lib/targets'
import { useWorkspace, type Screen } from '@/state/workspace'
import type { ProjectInspection, TargetCandidateInfo } from '@shared/ipc'
import {
  MINIMUM_PLAYWRIGHT_VERSION,
  PLAYWRIGHT_SCAFFOLD_OPTIONS,
  playwrightScaffoldOption,
  playwrightCompatibility
} from '@shared/playwright-compat'
import styles from './Detection.module.css'

const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+/

function tildePath(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}

function CardShell({
  name,
  path,
  pill,
  children,
  footer
}: {
  name: string
  path: string
  pill?: ReactNode
  children: ReactNode
  footer: ReactNode
}): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.tile}>
          <Icon name="folder" size={19} color="var(--ac-icon)" />
        </div>
        <div className={styles.identity}>
          <div className={styles.name}>{name}</div>
          <div className={styles.path}>{tildePath(path)}</div>
        </div>
        {pill}
      </div>
      {children}
      <div className={styles.footer}>{footer}</div>
    </div>
  )
}

function Footnote(): JSX.Element {
  return (
    <div className={styles.footnote}>
      Adding this project won&apos;t change its files — Wrightbench saves a reference in{' '}
      <span className={styles.footnoteMono}>~/.wrightbench/projects.json</span>.
    </div>
  )
}

function CreationFootnote(): JSX.Element {
  return (
    <div className={styles.footnote}>
      Wrightbench creates starter files in this folder and installs the selected exact{' '}
      <span className={styles.footnoteMono}>@playwright/test</span> release.
    </div>
  )
}

function BackLink(): JSX.Element {
  const pickAndInspect = useWorkspace((s) => s.pickAndInspect)
  return (
    <button type="button" className={styles.back} onClick={() => void pickAndInspect()}>
      <Icon name="chevron-left" size={13} />
      Choose a different folder
    </button>
  )
}

function ScaffoldBackLink(): JSX.Element {
  const scaffold = useWorkspace((s) => s.scaffold)
  return (
    <button type="button" className={styles.back} onClick={() => void scaffold()}>
      <Icon name="chevron-left" size={13} />
      Choose a different folder
    </button>
  )
}

const SCAFFOLD_VERSION_OPTIONS = PLAYWRIGHT_SCAFFOLD_OPTIONS.map((option) => ({
  value: option.value,
  label:
    option.channel === 'experimental'
      ? `npm ${option.value}`
      : option.recommended
        ? `${option.value} · Latest verified`
        : option.value,
  group: option.channel === 'verified' ? 'Verified releases' : 'Experimental'
}))

function ScaffoldSetup({
  screen
}: {
  screen: Extract<Screen, { name: 'scaffold-setup' }>
}): JSX.Element {
  const cancelDetection = useWorkspace((s) => s.cancelDetection)
  const confirmScaffold = useWorkspace((s) => s.confirmScaffold)
  const selectScaffoldVersion = useWorkspace((s) => s.selectScaffoldVersion)
  const name = screen.path.split('/').filter(Boolean).pop() ?? screen.path
  const selected = playwrightScaffoldOption(screen.version)
  const experimental = selected?.channel === 'experimental'

  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <ScaffoldBackLink />
        <CardShell
          name={name}
          path={screen.path}
          footer={
            <>
              <Button variant="ghost" size={34} muted onClick={cancelDetection}>
                Cancel
              </Button>
              <Button variant="primary" size={34} onClick={() => void confirmScaffold()}>
                Create project
              </Button>
            </>
          }
        >
          <div className={styles.rows}>
            <div className={styles.row}>
              <div className={styles.label}>Playwright version</div>
              <div className={`${styles.value} ${styles.versionValue}`}>
                <Select
                  options={SCAFFOLD_VERSION_OPTIONS}
                  value={screen.version}
                  onChange={(value) => {
                    const option = playwrightScaffoldOption(value)
                    if (option) selectScaffoldVersion(option.value)
                  }}
                  surface="panel"
                  mono
                  aria-label="Playwright version"
                  className={styles.versionSelect}
                  style={{ width: '100%' }}
                />
                <span className={experimental ? styles.experimentalHint : styles.versionHint}>
                  {experimental
                    ? `npm ${screen.version} is a moving tag and has not been verified with this Wrightbench release.`
                    : selected?.recommended
                      ? 'Recommended · newest release verified with this Wrightbench build.'
                      : 'Verified with this Wrightbench build and installed as an exact version.'}
                </span>
              </div>
            </div>
            {experimental && (
              <div className={styles.experimentalNote} role="note">
                <Icon name="warning" size={13} color="var(--flaky)" />
                <span>
                  Experimental releases may require a Wrightbench compatibility update. npm will
                  resolve the tag and lock the exact installed version.
                </span>
              </div>
            )}
          </div>
        </CardShell>
        <CreationFootnote />
      </div>
    </div>
  )
}

function configurationLabel(candidate: TargetCandidateInfo): string {
  return candidate.configPath ?? (candidate.cwd === '.' ? 'Default configuration' : candidate.cwd)
}

function ConfigurationRow({
  candidate,
  selected,
  onSelect
}: {
  candidate: TargetCandidateInfo
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const version = candidate.playwrightVersion
  const compatibility = playwrightCompatibility(version)
  const status =
    compatibility.reason === 'missing'
      ? 'Install dependencies'
      : compatibility.supported
        ? 'Wrightbench ready'
        : compatibility.reason === 'too-old'
          ? 'Upgrade required'
          : 'Unsupported version'
  const meta = [candidate.cwd === '.' ? null : candidate.cwd, version ? `Playwright v${version}` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={selected ? `${styles.targetRow} ${styles.targetRowSelected}` : styles.targetRow}
      onClick={onSelect}
      onKeyDown={navigateRadioGroup}
    >
      <span className={styles.targetIcon}>
        {compatibility.supported ? (
          <StatusDot status="pass" />
        ) : (
          <Icon name="warning" size={12} color="var(--flaky)" />
        )}
      </span>
      <span className={styles.targetText}>
        <span className={styles.targetLabel}>{configurationLabel(candidate)}</span>
        {meta !== '' && <span className={styles.targetMeta}>{meta}</span>}
      </span>
      <span
        className={
          !compatibility.supported
            ? `${styles.targetStatus} ${styles.targetStatusWarn}`
            : styles.targetStatus
        }
      >
        {status}
      </span>
    </button>
  )
}

/** Selection follows focus, matching the native radio-group keyboard model. */
function navigateRadioGroup(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  const container = event.currentTarget.parentElement
  if (!container) return
  const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
    (radio) => radio.parentElement === container
  )
  const currentIndex = radios.indexOf(event.currentTarget)
  const nextIndex = radioNavigationIndex(event.key, currentIndex, radios.length)
  if (nextIndex === null) return
  event.preventDefault()
  if (nextIndex === currentIndex) return
  radios[nextIndex].focus()
  radios[nextIndex].click()
}

function DetectionCard({
  inspection,
  selectedTargetId
}: {
  inspection: ProjectInspection
  selectedTargetId: string | null
}): JSX.Element {
  const confirmAdd = useWorkspace((s) => s.confirmAdd)
  const cancelDetection = useWorkspace((s) => s.cancelDetection)
  const selectDetectionTarget = useWorkspace((s) => s.selectDetectionTarget)
  const reinspect = useWorkspace((s) => s.reinspect)
  const pickConfigForDetection = useWorkspace((s) => s.pickConfigForDetection)
  const lastError = useWorkspace((s) => s.lastError)

  const selected =
    inspection.targets.find((target) => target.id === selectedTargetId) ??
    inspection.targets.find((target) => target.id === inspection.recommendedTargetId) ??
    inspection.targets[0] ??
    null
  const detected = selected !== null
  const version = selected ? selected.playwrightVersion : inspection.playwrightVersion
  const compatibility = playwrightCompatibility(version)
  const ready = detected && compatibility.supported

  const pill = ready ? (
    <div className={styles.detected}>
      <Icon name="check" size={12} />
      Ready for Wrightbench
    </div>
  ) : detected ? (
    <div className={`${styles.detected} ${styles.notDetected}`}>
      <Icon name="warning" size={12} />
      {compatibility.reason === 'missing'
        ? 'Dependencies required'
        : compatibility.reason === 'too-old'
          ? 'Upgrade required'
          : 'Unsupported version'}
    </div>
  ) : (
    <div className={`${styles.detected} ${styles.notDetected}`}>
      <Icon name="warning" size={12} />
      No configuration found
    </div>
  )

  return (
    <CardShell
      name={inspection.name}
      path={inspection.path}
      pill={pill}
      footer={
        <>
          {lastError && (
            <span className={styles.footerError} role="alert">
              {lastError}
            </span>
          )}
          <Button variant="ghost" size={34} muted onClick={cancelDetection}>
            Cancel
          </Button>
          {ready ? (
            <Button variant="primary" size={34} onClick={() => void confirmAdd()}>
              Add and open UI Mode
            </Button>
          ) : detected ? (
            <Button variant="primary" size={34} onClick={() => void reinspect()}>
              <Icon name="rotate-cw" size={12} />
              Retry detection
            </Button>
          ) : (
            <Button variant="primary" size={34} disabled>
              Add and open UI Mode
            </Button>
          )}
        </>
      }
    >
      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.label}>
            {inspection.targets.length > 1 ? 'Configuration' : 'Config'}
          </div>
          {inspection.targets.length > 1 ? (
            <div
              role="radiogroup"
              aria-label="Playwright configurations"
              className={styles.targetList}
            >
              {inspection.targets.map((candidate) => (
                <ConfigurationRow
                  key={candidate.id}
                  candidate={candidate}
                  selected={candidate.id === selected?.id}
                  onSelect={() => selectDetectionTarget(candidate.id)}
                />
              ))}
            </div>
          ) : detected ? (
            <div className={`${styles.value} ${styles.valueWrap}`}>
              <span className={styles.mono}>{configurationLabel(selected)}</span>
              {selected.cwd !== '.' && <span className={styles.note}>from {selected.cwd}</span>}
            </div>
          ) : (
            <div className={`${styles.value} ${styles.valueWrap}`}>
              <span className={styles.note}>No Playwright configuration was found in this folder.</span>
              <Button variant="pill" size={26} onClick={() => void pickConfigForDetection()}>
                <Icon name="file" size={12} />
                Choose a config file…
              </Button>
            </div>
          )}
        </div>

        {detected && (
          <div className={styles.row}>
            <div className={styles.label}>Playwright</div>
            <div className={`${styles.value} ${styles.valueWrap}`}>
              {version ? (
                compatibility.supported ? (
                  <>
                    <span className={styles.mono}>v{version}</span>
                    <span className={styles.note}>
                      Supported by Wrightbench · minimum v{MINIMUM_PLAYWRIGHT_VERSION}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={styles.mono}>v{version}</span>
                    <span className={styles.problem}>{compatibility.message}</span>
                  </>
                )
              ) : (
                <span className={styles.problem}>{compatibility.message}</span>
              )}
            </div>
          </div>
        )}

        {ready && (
          <div className={styles.ownershipNote}>
            <Icon name="check" size={12} color="var(--pass)" />
            <span>
              Playwright UI Mode handles test discovery, configured projects, and browser requirements after opening.
            </span>
          </div>
        )}
      </div>
    </CardShell>
  )
}

export function Detection({ screen }: { screen: Screen }): JSX.Element | null {
  const cancelDetection = useWorkspace((s) => s.cancelDetection)

  if (screen.name === 'scaffold-setup') return <ScaffoldSetup screen={screen} />

  if (screen.name === 'inspecting') {
    const name = screen.path.split('/').filter(Boolean).pop() ?? screen.path
    return (
      <div className={styles.page}>
        <div className={styles.column}>
          <BackLink />
          <CardShell
            name={name}
            path={screen.path}
            footer={
              <Button variant="ghost" size={34} muted onClick={cancelDetection}>
                Cancel
              </Button>
            }
          >
            <div className={styles.busy}>
              <Spinner size={12} />
              Finding Playwright configurations…
            </div>
          </CardShell>
          <Footnote />
        </div>
      </div>
    )
  }

  if (screen.name === 'scaffolding') {
    const name = screen.path.split('/').filter(Boolean).pop() ?? screen.path
    return (
      <div className={styles.page}>
        <div className={styles.column}>
          <CardShell
            name={name}
            path={screen.path}
            footer={
              <Button variant="ghost" size={34} muted onClick={cancelDetection}>
                {screen.error ? 'Back' : 'Cancel'}
              </Button>
            }
          >
            <div className={styles.busy}>
              {screen.error ? (
                <span className={styles.problem}>{screen.error}</span>
              ) : (
                <>
                  <Spinner size={12} />
                  Creating with Playwright {screen.version}…
                </>
              )}
            </div>
            {screen.lines.length > 0 && (
              <div className={styles.log}>
                {screen.lines.slice(-8).map((line, i) => (
                  <div key={i} className={styles.logLine}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </CardShell>
          <CreationFootnote />
        </div>
      </div>
    )
  }

  if (screen.name !== 'detection') return null
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <BackLink />
        <DetectionCard
          inspection={screen.inspection}
          selectedTargetId={screen.selectedTargetId}
        />
        <Footnote />
      </div>
    </div>
  )
}
