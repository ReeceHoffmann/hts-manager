import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('creates the merged schema for a fresh database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fresh-'))
  process.env.HTSM_DB_PATH = join(directory, 'hts-manager.db')

  const { getDb, migrateDatabase } = await import('../../src/db/db')
  const { claimJob, enqueueJob, updateJobState } = await import(
    '../../src/db/jobs'
  )
  migrateDatabase()
  const db = getDb()

  try {
    const objects = db
      .prepare(
        `SELECT name, type FROM sqlite_master
          WHERE name IN ('runs', 'jobs', 'transfer_jobs', 'transfer_sources',
                         'transfer_source_status')
          ORDER BY name`,
      )
      .all()
    assert.deepEqual(objects, [
      { name: 'jobs', type: 'table' },
      { name: 'runs', type: 'table' },
    ])

    const runColumns = (
      db.prepare('PRAGMA table_info(runs)').all() as Array<{
        name: string
        notnull: number
      }>
    ).map(({ name, notnull }) => ({ name, notnull }))
    assert.ok(
      runColumns.some(
        (column) => column.name === 'transfer_status' && column.notnull === 1,
      ),
    )
    assert.ok(
      runColumns.some(
        (column) => column.name === 'last_scanned_at' && column.notnull === 0,
      ),
    )
    const jobColumns = (
      db.prepare('PRAGMA table_info(jobs)').all() as Array<{
        name: string
        type: string
        notnull: number
      }>
    ).map(({ name, type, notnull }) => ({ name, type, notnull }))
    assert.ok(
      jobColumns.some(
        (column) =>
          column.name === 'target_type' &&
          column.type === 'TEXT' &&
          column.notnull === 0,
      ),
    )
    assert.ok(
      jobColumns.some(
        (column) =>
          column.name === 'target_id' &&
          column.type === 'INTEGER' &&
          column.notnull === 0,
      ),
    )
    const jobIndexes = (
      db.pragma('index_list(jobs)') as Array<{
        name: string
        unique: number
      }>
    )
      .map(({ name, unique }) => ({ name, unique }))
      .sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(jobIndexes, [
      { name: 'idx_jobs_kind_state', unique: 0 },
      { name: 'idx_jobs_target_kind_state', unique: 0 },
    ])
    assert.deepEqual(db.pragma('foreign_key_list(jobs)'), [])
    assert.equal(claimJob([]), undefined)

    const laterJobId = Number(
      db
        .prepare(
          `INSERT INTO jobs (kind, payload, created_at)
           VALUES (?, ?, ?)`,
        )
        .run('copy', '{}', '2026-01-02T00:00:00.000Z')
        .lastInsertRowid,
    )
    const earlierJobId = Number(
      db
        .prepare(
          `INSERT INTO jobs (kind, payload, created_at)
           VALUES (?, ?, ?)`,
        )
        .run('discover', '{}', '2026-01-01T00:00:00.000Z')
        .lastInsertRowid,
    )

    const earlierJob = claimJob(['discover', 'copy'])!
    assert.equal(earlierJob.id, earlierJobId)
    assert.equal(earlierJob.state, 'running')
    assert.ok(earlierJob.started_at)
    updateJobState(earlierJob.id, 'complete')

    const laterJob = claimJob(['discover', 'copy'])!
    assert.equal(laterJob.id, laterJobId)
    updateJobState(laterJob.id, 'complete')

    const enqueuedJob = enqueueJob({
      kind: 'remove',
      target: { type: 'run', id: 42 },
      payload: { source: '/source/run' },
    })
    assert.deepEqual(
      {
        kind: enqueuedJob.kind,
        target_type: enqueuedJob.target_type,
        target_id: enqueuedJob.target_id,
        payload: JSON.parse(enqueuedJob.payload),
        state: enqueuedJob.state,
      },
      {
        kind: 'remove',
        target_type: 'run',
        target_id: 42,
        payload: { source: '/source/run' },
        state: 'waiting',
      },
    )
    updateJobState(claimJob(['remove'])!.id, 'complete')

    assert.throws(
      () => enqueueJob({ kind: 'discover', payload: Symbol('invalid') }),
      /job payload must be JSON-serializable/,
    )

    db.prepare(
      `INSERT INTO jobs (kind, payload, created_at)
       VALUES (?, ?, ?)`,
    ).run('example.custom', JSON.stringify(['any', 'json', 'shape']), 'now')
    assert.deepEqual(
      db
        .prepare(
          `SELECT kind, target_type, target_id, payload, state FROM jobs
            WHERE kind = ?`,
        )
        .get('example.custom'),
      {
        kind: 'example.custom',
        target_type: null,
        target_id: null,
        payload: '["any","json","shape"]',
        state: 'waiting',
      },
    )

    db.prepare(
      `INSERT INTO jobs
         (kind, target_type, target_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('copy', 'run', 42, '{}', 'now')
    assert.deepEqual(
      db
        .prepare(
          `SELECT target_type, target_id, kind, state
             FROM jobs
            WHERE target_type = ? AND target_id = ? AND kind = ?
              AND state = ?`,
        )
        .get('run', 42, 'copy', 'waiting'),
      {
        target_type: 'run',
        target_id: 42,
        kind: 'copy',
        state: 'waiting',
      },
    )
    db.prepare(
      `INSERT INTO jobs
         (kind, target_type, target_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('copy', 'run', 42, '{}', 'later')
    assert.deepEqual(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM jobs
            WHERE target_type = ? AND target_id = ? AND kind = ?`,
        )
        .get('run', 42, 'copy'),
      { count: 2 },
    )

    for (const invalidTarget of [
      { targetType: 'run', targetId: null },
      { targetType: null, targetId: 42 },
      { targetType: '  ', targetId: 42 },
      { targetType: 'run', targetId: 'not-an-integer' },
    ]) {
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO jobs
                 (kind, target_type, target_id, payload, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              'copy',
              invalidTarget.targetType,
              invalidTarget.targetId,
              '{}',
              'now',
            ),
        /CHECK constraint failed/,
      )
    }
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO jobs (kind, payload, created_at)
             VALUES (?, ?, ?)`,
          )
          .run('example.invalid', 'not json', 'now'),
      /CHECK constraint failed/,
    )

    const waitingJobId = Number(
      db
        .prepare(
          `INSERT INTO jobs (kind, payload, created_at)
           VALUES (?, ?, ?)`,
        )
        .run('example.transition', '{}', 'now').lastInsertRowid,
    )
    assert.throws(
      () => updateJobState(waitingJobId, 'complete'),
      /cannot transition job .* from waiting to complete/,
    )

    const runningJob = updateJobState(waitingJobId, 'running')
    assert.ok(runningJob.started_at)
    assert.equal(runningJob.finished_at, null)
    assert.throws(
      () => updateJobState(waitingJobId, 'waiting'),
      /cannot transition job .* from running to waiting/,
    )

    const completeJob = updateJobState(waitingJobId, 'complete')
    assert.ok(completeJob.finished_at)
    assert.equal(completeJob.error_message, null)
    assert.throws(
      () => updateJobState(waitingJobId, 'error', 'too late'),
      /cannot transition job .* from complete to error/,
    )

    const errorJobId = Number(
      db
        .prepare(
          `INSERT INTO jobs (kind, payload, created_at)
           VALUES (?, ?, ?)`,
        )
        .run('example.error', '{}', 'now').lastInsertRowid,
    )
    updateJobState(errorJobId, 'running')
    assert.throws(
      () => updateJobState(errorJobId, 'error', '  '),
      /error message must not be empty/,
    )
    const errorJob = updateJobState(errorJobId, 'error', 'failed')
    assert.equal(errorJob.state, 'error')
    assert.equal(errorJob.error_message, 'failed')
    assert.ok(errorJob.finished_at)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
