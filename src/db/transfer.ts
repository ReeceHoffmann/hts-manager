/** Typed query helpers for run discovery and transfer operations. */
import { parseRunFolder } from '../scan/parse'
import { getDb } from './db'
import {
  type RunRow,
  type RunTransferStatus,
  type RunWithTransferActivity,
  type TransferActivity,
} from './runs'
import { enqueueJob, type JobRow } from './jobs'
import { nowIso } from './utils'

function requireMessage(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`)
}

/** Allowed durable status transitions for transfer-managed runs. */
export const RUN_TRANSFER_STATUS_TRANSITIONS = {
  manual: [],
  detected: ['ready'],
  ready: ['transferred'],
  transferred: ['removed'],
  removed: [],
} as const satisfies Record<RunTransferStatus, readonly RunTransferStatus[]>

type RunTransferOperation = 'copy' | 'remove'

type RunTransferOperationRule = {
  requiredRunStatus: RunTransferStatus
  completedRunStatus: RunTransferStatus
  activity: Exclude<TransferActivity, null>
}

/** How each run transfer operation relates to the durable run lifecycle. */
const RUN_TRANSFER_OPERATION_RULES = {
  copy: {
    requiredRunStatus: 'ready',
    completedRunStatus: 'transferred',
    activity: 'copying',
  },
  remove: {
    requiredRunStatus: 'transferred',
    completedRunStatus: 'removed',
    activity: 'removing',
  },
} as const satisfies Record<RunTransferOperation, RunTransferOperationRule>

const TRANSFER_ACTIVITY_SQL = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM jobs
       WHERE target_type = 'run'
         AND target_id = run.id
         AND kind = 'remove'
         AND state = 'running'
    ) THEN '${RUN_TRANSFER_OPERATION_RULES.remove.activity}'
    WHEN EXISTS (
      SELECT 1 FROM jobs
       WHERE target_type = 'run'
         AND target_id = run.id
         AND kind = 'copy'
         AND state = 'running'
    ) THEN '${RUN_TRANSFER_OPERATION_RULES.copy.activity}'
    ELSE NULL
  END AS transfer_activity
`

/**
 * Atomically advance a run to an allowed durable transfer status.
 * Initial statuses (`manual` and `detected`) are assigned when runs are created.
 */
export function transitionRunTransferStatus(
  id: number,
  nextStatus: RunTransferStatus,
): void {
  const db = getDb()
  const current = db
    .prepare('SELECT transfer_status FROM runs WHERE id = ?')
    .get(id) as { transfer_status: RunTransferStatus } | undefined

  if (!current) throw new Error(`run ${id} not found`)

  const allowedStatuses: readonly RunTransferStatus[] =
    RUN_TRANSFER_STATUS_TRANSITIONS[current.transfer_status]
  if (!allowedStatuses.includes(nextStatus)) {
    throw new Error(
      `cannot transition run ${id} from ${current.transfer_status} to ${nextStatus}`,
    )
  }

  const result = db
    .prepare(
      `UPDATE runs
          SET transfer_status = ?
        WHERE id = ? AND transfer_status = ?`,
    )
    .run(nextStatus, id, current.transfer_status)

  if (result.changes === 0) {
    throw new Error(`run ${id} changed while transitioning to ${nextStatus}`)
  }
}

/** Mark a detected run as stable and eligible for a copy job. */
export function markRunReady(id: number): void {
  transitionRunTransferStatus(id, 'ready')
}

/** Mark a ready run as successfully transferred. */
export function markRunTransferred(id: number): void {
  transitionRunTransferStatus(
    id,
    RUN_TRANSFER_OPERATION_RULES.copy.completedRunStatus,
  )
}

/** Mark a transferred run's source as successfully removed. */
export function markRunRemoved(id: number): void {
  transitionRunTransferStatus(
    id,
    RUN_TRANSFER_OPERATION_RULES.remove.completedRunStatus,
  )
}

export type UpsertDetectedRunInput = {
  runFolder: string
  sourcePath: string
}

/**
 * Insert a newly detected source run, or return the matching known run.
 * Manual runs are deliberately never enrolled into the managed lifecycle.
 */
export function upsertDetectedRun(
  input: UpsertDetectedRunInput,
): RunRow {
  requireMessage(input.sourcePath, 'source path')
  const metadata = parseRunFolder(input.runFolder)
  if (!metadata) {
    throw new Error(`run folder is not parseable: ${input.runFolder}`)
  }

  const db = getDb()
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM runs WHERE run_folder = ?')
      .get(input.runFolder) as RunRow | undefined

    if (existing) {
      if (existing.transfer_status === 'manual') return existing
      if (existing.source_path !== input.sourcePath) {
        throw new Error(
          `run folder ${input.runFolder} is already associated with source path ` +
            existing.source_path,
        )
      }
      return existing
    }

    const pathOwner = db
      .prepare('SELECT run_folder FROM runs WHERE source_path = ?')
      .get(input.sourcePath) as { run_folder: string } | undefined
    if (pathOwner) {
      throw new Error(
        `source path ${input.sourcePath} is already associated with run folder ` +
          pathOwner.run_folder,
      )
    }

    const now = nowIso()
    return db
      .prepare(
        `INSERT INTO runs
           (run_folder, source_path, transfer_status, run_date, instrument,
            run_number, flowcell, first_seen_at, last_scanned_at)
         VALUES
           (@run_folder, @source_path, 'detected', @run_date, @instrument,
            @run_number, @flowcell, @first_seen_at, NULL)
         RETURNING *`,
      )
      .get({
        run_folder: input.runFolder,
        source_path: input.sourcePath,
        ...metadata,
        first_seen_at: now,
      }) as RunRow
  })()
}

function requireRunWithSourcePath(runId: number): RunRow {
  const run = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
    | RunRow
    | undefined
  if (!run) throw new Error(`run ${runId} not found`)
  if (!run.source_path) throw new Error(`run ${runId} requires a source path`)
  return run
}

/** Queue a discovery pass unless one is already waiting or running. */
export function queueDiscoveryJob(): void {
  const db = getDb()
  db.transaction(() => {
    const active = db
      .prepare(
        `SELECT * FROM jobs
          WHERE kind = 'discover'
            AND target_type IS NULL
            AND target_id IS NULL
            AND state IN ('waiting', 'running')
          ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                   created_at ASC,
                   id ASC
          LIMIT 1`,
      )
      .get() as JobRow | undefined

    if (!active) enqueueJob({ kind: 'discover' })
  })()
}

/** Queue destination copying for a ready run. */
export function queueRunCopyJob(runId: number): JobRow {
  const run = requireRunWithSourcePath(runId)
  if (
    run.transfer_status !==
    RUN_TRANSFER_OPERATION_RULES.copy.requiredRunStatus
  ) {
    throw new Error(
      `copy jobs require a run with transfer status ${RUN_TRANSFER_OPERATION_RULES.copy.requiredRunStatus}`,
    )
  }

  return enqueueJob({ kind: 'copy', target: { type: 'run', id: runId } })
}

/** Queue source removal for a transferred run. */
export function queueRunRemovalJob(runId: number): JobRow {
  const run = requireRunWithSourcePath(runId)
  if (
    run.transfer_status !==
    RUN_TRANSFER_OPERATION_RULES.remove.requiredRunStatus
  ) {
    throw new Error(
      `remove jobs require a run with transfer status ${RUN_TRANSFER_OPERATION_RULES.remove.requiredRunStatus}`,
    )
  }

  return enqueueJob({ kind: 'remove', target: { type: 'run', id: runId } })
}

export type TransferRunSummary = RunWithTransferActivity & {
  last_error: string | null
}

const TRANSFER_RUN_SUMMARY_SQL = `
  SELECT run.*,
         ${TRANSFER_ACTIVITY_SQL},
         (
           SELECT error_message FROM jobs
            WHERE target_type = 'run'
              AND target_id = run.id
              AND state = 'error'
            ORDER BY id DESC
            LIMIT 1
         ) AS last_error
    FROM runs AS run
`

/** Transfer-managed runs with at least one failed job. */
export function listProblemTransferRuns(limit = 20): TransferRunSummary[] {
  return getDb()
    .prepare(
      `${TRANSFER_RUN_SUMMARY_SQL}
        WHERE EXISTS (
          SELECT 1 FROM jobs
           WHERE target_type = 'run'
             AND target_id = run.id
             AND state = 'error'
        )
        ORDER BY first_seen_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as TransferRunSummary[]
}
