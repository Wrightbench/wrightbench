import { useState, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog/ConfirmDialog'
import { Icon } from '@/components/Icon/Icon'
import { useRun } from '@/state/run'
import { useWorkspace } from '@/state/workspace'
import type { ProjectWithHealth } from '@shared/ipc'
import styles from './ProjectUnavailable.module.css'

export interface ProjectUnavailableProps {
  project: ProjectWithHealth
  /** health = folder missing/unreadable · load = folder fine, listing failed */
  kind: 'health' | 'load'
}

/**
 * Deliberate recovery surface replacing the tab content when the active
 * project can't be used. For listing failures the underlying cause is shown
 * (IPC wrapper stripped) — "missing deps" and "config crashed on load" need
 * different fixes and the calm headline alone can't tell them apart. The
 * Reports stays reachable (it is Wrightbench-owned), and the project
 * remains registered until the user removes it here or from the switcher.
 */
export function ProjectUnavailable({ project, kind }: ProjectUnavailableProps): JSX.Element {
  const refreshProjects = useWorkspace((s) => s.refreshProjects)
  const removeProject = useWorkspace((s) => s.removeProject)
  const loadTree = useRun((s) => s.loadTree)
  const pickConfigTarget = useRun((s) => s.pickConfigTarget)
  const treeErrorDetail = useRun((s) => s.treeErrorDetail)
  const treeDiagnostic = useRun((s) => s.treeDiagnostic)
  const [confirming, setConfirming] = useState(false)

  const title = kind === 'load' ? 'Playwright could not load this project' : 'Project folder unavailable'
  const body =
    kind === 'load'
      ? 'The project folder exists, but its tests couldn’t be listed.'
      : project.health.state === 'unreadable'
        ? 'Wrightbench can’t access this project folder.'
        : 'Wrightbench can no longer find this project folder.'

  const retry = (): void => {
    if (kind === 'load') void loadTree()
    else void refreshProjects()
  }

  return (
    <div className={styles.root}>
      <Icon name="warning" size={15} color="var(--flaky)" />
      <div className={styles.title}>{title}</div>
      <div className={styles.body}>{body}</div>
      <div className={styles.path}>{project.path}</div>
      {kind === 'load' && treeErrorDetail && (
        <div className={styles.detail}>{treeErrorDetail}</div>
      )}
      {kind === 'load' && treeDiagnostic?.suggestion && (
        <div className={styles.suggestion}>{treeDiagnostic.suggestion}</div>
      )}
      <div className={styles.actions}>
        <Button variant="ghost" size={32} onClick={retry}>
          <Icon name="rotate-cw" size={13} />
          Retry
        </Button>
        {kind === 'load' && (
          <Button variant="ghost" size={32} onClick={() => void pickConfigTarget()}>
            <Icon name="file" size={13} />
            Choose a config file…
          </Button>
        )}
        <Button variant="danger-outline" size={32} onClick={() => setConfirming(true)}>
          Remove from Wrightbench
        </Button>
      </div>
      <div className={styles.note}>Reports remain available from the global header.</div>
      {confirming && (
        <ConfirmDialog
          danger
          title={`Remove “${project.name}” from Wrightbench?`}
          body="The project’s files will not be changed. Existing run history will be preserved."
          detail={project.path}
          confirmLabel="Remove from Wrightbench"
          onConfirm={() => {
            setConfirming(false)
            void removeProject(project.id)
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
