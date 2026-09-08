import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

test('migrates existing runs and enforces the stable transfer lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-transfer-'))
  const databasePath = join(directory, 'hts-manager.db')
  const legacy = new Database(databasePath)

  legacy.pragma('foreign_keys = ON')
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY,
      run_folder TEXT UNIQUE NOT NULL,
      run_date TEXT NOT NULL,
      instrument TEXT NOT NULL,
      run_number TEXT NOT NULL,
      flowcell TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL
    );
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      run_id INTEGER REFERENCES runs(id),
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      lane TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      upload_requested INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      upload_status TEXT NOT NULL DEFAULT 'idle',
      upload_error TEXT,
      uploaded_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL
    );
    INSERT INTO runs VALUES (
      7,
      '260101_NS123_0001_FLOW',
      '2026-01-01',
      'NS123',
      '0001',
      'FLOW',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    );
    INSERT INTO files (
      id, run_id, path, name, size, first_seen_at, last_scanned_at
    ) VALUES (
      11,
      7,
      '/destination/260101_NS123_0001_FLOW/sample.fastq.gz',
      'sample.fastq.gz',
      100,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    );
  `)
  legacy.close()

  process.env.HTSM_DB_PATH = databasePath

  const { getDb, migrateDatabase } = await import('../../src/db/db')
  const { claimJob, updateJobState } = await import('../../src/db/jobs')
  const {
    listProblemTransferRuns,
    markRunReady,
    markRunRemoved,
    markRunTransferred,
    queueDiscoveryJob,
    queueRunCopyJob,
    queueRunRemovalJob,
    upsertDetectedRun,
  } = await import('../../src/db/transfer')
  const { flagMissingExcept, insertIfNew } = await import('../../src/db/files')
  const { getRunById } = await import('../../src/db/runs')

  migrateDatabase()
  const db = getDb()

  try {
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
      [{ version: 1 }, { version: 2 }, { version: 3 }],
    )
    assert.deepEqual(db.pragma('foreign_key_check'), [])

    const migrated = db.prepare('SELECT * FROM runs WHERE id = 7').get() as {
      source_path: string | null
      transfer_status: string
      last_scanned_at: string | null
    }
    assert.equal(migrated.source_path, null)
    assert.equal(migrated.transfer_status, 'manual')
    assert.equal(migrated.last_scanned_at, '2026-01-02T00:00:00.000Z')
    assert.deepEqual(
      db.prepare('SELECT id, run_id FROM files WHERE id = 11').get(),
      { id: 11, run_id: 7 },
    )

    const skippedManual = upsertDetectedRun({
      runFolder: '260101_NS123_0001_FLOW',
      sourcePath: '/source/260101_NS123_0001_FLOW',
    })
    assert.equal(skippedManual.transfer_status, 'manual')
    assert.equal(skippedManual.source_path, null)

    const detected = upsertDetectedRun({
      runFolder: '260102_NS123_0002_FLOW2',
      sourcePath: '/source/260102_NS123_0002_FLOW2',
    })
    assert.equal(detected.transfer_status, 'detected')
    assert.equal(detected.last_scanned_at, null)
    assert.equal(detected.run_date, '2026-01-02')

    const destinationPath =
      '/destination/260102_NS123_0002_FLOW2/sample_L001_R1.fastq.gz'
    assert.equal(
      insertIfNew({
        path: destinationPath,
        name: 'sample_L001_R1.fastq.gz',
        size: 200,
        lane: 'L001',
        run_folder: detected.run_folder,
        run_date: detected.run_date,
        instrument: detected.instrument,
        run_number: detected.run_number,
        flowcell: detected.flowcell,
      }),
      true,
    )
    flagMissingExcept('/destination', [destinationPath])
    const indexedManagedRun = db
      .prepare(
        `SELECT transfer_status, source_path, last_scanned_at
           FROM runs WHERE id = ?`,
      )
      .get(detected.id) as {
        transfer_status: string
        source_path: string | null
        last_scanned_at: string | null
      }
    assert.equal(indexedManagedRun.transfer_status, 'detected')
    assert.equal(indexedManagedRun.source_path, detected.source_path)
    assert.ok(indexedManagedRun.last_scanned_at)

    assert.equal(
      insertIfNew({
        path: '/destination/260103_NS123_0003_FLOW3/manual.fastq.gz',
        name: 'manual.fastq.gz',
        size: 300,
        lane: null,
        run_folder: '260103_NS123_0003_FLOW3',
        run_date: '2026-01-03',
        instrument: 'NS123',
        run_number: '0003',
        flowcell: 'FLOW3',
      }),
      true,
    )
    assert.deepEqual(
      db
        .prepare(
          `SELECT transfer_status, source_path FROM runs
            WHERE run_folder = '260103_NS123_0003_FLOW3'`,
        )
        .get(),
      { transfer_status: 'manual', source_path: null },
    )

    const rediscovered = upsertDetectedRun({
      runFolder: detected.run_folder,
      sourcePath: detected.source_path!,
    })
    assert.equal(rediscovered.id, detected.id)

    assert.throws(
      () =>
        upsertDetectedRun({
          runFolder: detected.run_folder,
          sourcePath: '/source/moved-run',
        }),
      /already associated with source path/,
    )
    assert.throws(
      () => queueRunCopyJob(detected.id),
      /transfer status ready/,
    )

    markRunReady(detected.id)
    assert.throws(
      () => markRunReady(detected.id),
      /cannot transition run .* from ready to ready/,
    )
    queueDiscoveryJob()
    queueDiscoveryJob()
    const discovery = claimJob(['discover'])!
    assert.equal(discovery.kind, 'discover')
    assert.equal(discovery.target_type, null)
    assert.equal(discovery.target_id, null)
    queueDiscoveryJob()
    assert.deepEqual(
      db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'discover'")
        .get(),
      { count: 1 },
    )
    updateJobState(discovery.id, 'complete')

    queueDiscoveryJob()
    const nextDiscovery = claimJob(['discover'])!
    assert.notEqual(nextDiscovery.id, discovery.id)
    updateJobState(nextDiscovery.id, 'complete')

    const copy = queueRunCopyJob(detected.id)
    assert.equal(copy.state, 'waiting')
    assert.equal(copy.target_type, 'run')
    assert.equal(copy.target_id, detected.id)
    assert.equal(getRunById(detected.id)?.transfer_activity, null)
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'ready' },
    )

    const failedCopy = claimJob(['copy'])!
    assert.equal(failedCopy.id, copy.id)
    assert.equal(getRunById(detected.id)?.transfer_activity, 'copying')
    updateJobState(failedCopy.id, 'error', 'copy failed')
    assert.equal(getRunById(detected.id)?.transfer_activity, null)
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'ready' },
    )

    queueRunCopyJob(detected.id)
    const completedCopy = claimJob(['copy'])!
    updateJobState(completedCopy.id, 'complete')
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'ready' },
    )
    markRunTransferred(detected.id)
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'transferred' },
    )

    queueRunRemovalJob(detected.id)
    const failedRemoval = claimJob(['remove'])!
    assert.equal(getRunById(detected.id)?.transfer_activity, 'removing')
    updateJobState(failedRemoval.id, 'error', 'remove failed')
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'transferred' },
    )

    queueRunRemovalJob(detected.id)
    const completedRemoval = claimJob(['remove'])!
    updateJobState(completedRemoval.id, 'complete')
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'transferred' },
    )
    markRunRemoved(detected.id)
    assert.deepEqual(
      db.prepare('SELECT transfer_status FROM runs WHERE id = ?').get(detected.id),
      { transfer_status: 'removed' },
    )
    assert.throws(
      () => queueRunRemovalJob(detected.id),
      /transfer status transferred/,
    )

    const problems = listProblemTransferRuns()
    assert.equal(problems.length, 1)
    assert.equal(problems[0]?.id, detected.id)
    assert.equal(problems[0]?.last_error, 'remove failed')

  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
