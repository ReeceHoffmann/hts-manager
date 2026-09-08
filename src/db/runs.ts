import type { DerivedRecord } from '../scan/parse'
import { getDb } from './db'
import { nowIso } from './utils'

/** Durable transfer milestone for a run; temporary activity lives on jobs. */
export type RunTransferStatus =
  | 'manual'
  | 'detected'
  | 'ready'
  | 'transferred'
  | 'removed'

/** Row shape of the `runs` table. */
export type RunRow = {
  id: number
  run_folder: string
  source_path: string | null
  transfer_status: RunTransferStatus
  run_date: string
  instrument: string
  run_number: string
  flowcell: string
  first_seen_at: string
  last_scanned_at: string | null
}

export type TransferActivity = 'copying' | 'removing' | null

export type RunWithTransferActivity = RunRow & {
  transfer_activity: TransferActivity
}

/** A run with the number of associated files. */
export type RunSummary = RunWithTransferActivity & {
  file_count: number
}

/**
 * Insert or look up the run record for a derived file, returning its id.
 * The `runs` table deduplicates by `run_folder`; subsequent files in the same
 * run folder get the same id. `last_scanned_at` is refreshed on every call so
 * it reflects the most-recent scan that visited this run.
 */
export function upsertRun(file: DerivedRecord): number {
  const db = getDb()
  const now = nowIso()
  db.prepare(
    `INSERT OR IGNORE INTO runs
       (run_folder, run_date, instrument, run_number, flowcell,
        first_seen_at, last_scanned_at)
     VALUES
       (@run_folder, @run_date, @instrument, @run_number, @flowcell,
        @first_seen_at, @last_scanned_at)`,
  ).run({
    run_folder: file.run_folder,
    run_date: file.run_date,
    instrument: file.instrument,
    run_number: file.run_number,
    flowcell: file.flowcell,
    first_seen_at: now,
    last_scanned_at: now,
  })
  return (
    db.prepare('SELECT id FROM runs WHERE run_folder = ?').get(file.run_folder) as {
      id: number
    }
  ).id
}

/** List all runs, newest run date first. */
export function listRuns(): RunSummary[] {
  return getDb()
    .prepare(
      `SELECT r.*,
              COUNT(f.id) AS file_count,
              CASE
                  WHEN EXISTS (
                    SELECT 1 FROM jobs
                     WHERE target_type = 'run'
                       AND target_id = r.id
                       AND kind = 'remove'
                       AND state = 'running'
                  ) THEN 'removing'
                  WHEN EXISTS (
                    SELECT 1 FROM jobs
                     WHERE target_type = 'run'
                       AND target_id = r.id
                       AND kind = 'copy'
                       AND state = 'running'
                  ) THEN 'copying'
                  ELSE NULL
                END AS transfer_activity
         FROM runs r
         LEFT JOIN files f ON f.run_id = r.id
        GROUP BY r.id
        ORDER BY r.run_date DESC, r.run_folder ASC`,
    )
    .all() as RunSummary[]
}

/** Fetch a single run by id, or undefined if not found. */
export function getRunById(
  id: number,
): RunWithTransferActivity | undefined {
  return getDb()
    .prepare(
      `SELECT run.*,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM jobs
                   WHERE target_type = 'run'
                     AND target_id = run.id
                     AND kind = 'remove'
                     AND state = 'running'
                ) THEN 'removing'
                WHEN EXISTS (
                  SELECT 1 FROM jobs
                   WHERE target_type = 'run'
                     AND target_id = run.id
                     AND kind = 'copy'
                     AND state = 'running'
                ) THEN 'copying'
                ELSE NULL
              END AS transfer_activity
         FROM runs AS run
        WHERE id = ?`,
    )
    .get(id) as RunWithTransferActivity | undefined
}

/** Fetch a run by its authoritative Illumina folder name. */
export function getRunByFolder(runFolder: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM runs WHERE run_folder = ?').get(
    runFolder,
  ) as RunRow | undefined
}
