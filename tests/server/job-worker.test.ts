import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('spawns and serially runs every supported job kind', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-job-worker-'))
  process.env.HTSM_DB_PATH = join(directory, 'hts-manager.db')

  const { getDb, migrateDatabase } = await import('../../src/db/db')
  const { enqueueJob } = await import('../../src/db/jobs')
  const {
    createJobRegistries,
    runJobSpawners,
    runNextJob,
    startJobWorkers,
  } = await import('../../src/server/job-worker')

  migrateDatabase()
  const db = getDb()

  try {
    let spawnedJobId: number | undefined
    await runJobSpawners({
      discover: () => {
        spawnedJobId = enqueueJob({ kind: 'discover' }).id
      },
    })

    assert.ok(spawnedJobId)
    assert.deepEqual(
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(spawnedJobId),
      { state: 'waiting' },
    )

    let handlerState: string | undefined
    assert.equal(
      await runNextJob({
        discover: (job) => {
          handlerState = job.state
          assert.deepEqual(
            db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id),
            { state: 'running' },
          )
        },
      }),
      true,
    )
    assert.equal(handlerState, 'running')
    assert.deepEqual(
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(spawnedJobId),
      { state: 'complete' },
    )

    const unsupported = enqueueJob({ kind: 'discover' })
    const failing = enqueueJob({ kind: 'copy' })
    const succeeding = enqueueJob({ kind: 'remove' })
    const handledKinds: string[] = []
    const handlers = {
      copy: (job: { kind: string }) => {
        handledKinds.push(job.kind)
        throw new Error('handler exploded')
      },
      remove: (job: { kind: string }) => {
        handledKinds.push(job.kind)
      },
    }

    assert.equal(await runNextJob(handlers), true)
    assert.equal(await runNextJob(handlers), true)
    assert.deepEqual(handledKinds, ['copy', 'remove'])
    assert.deepEqual(
      db
        .prepare('SELECT state, error_message FROM jobs WHERE id = ?')
        .get(failing.id),
      { state: 'error', error_message: 'handler exploded' },
    )
    assert.deepEqual(
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(succeeding.id),
      { state: 'complete' },
    )
    assert.deepEqual(
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(unsupported.id),
      { state: 'waiting' },
    )

    const { readConfig } = await import('../../src/server/config')
    const disabled = createJobRegistries(readConfig({}))
    assert.deepEqual(disabled, { spawners: {}, handlers: {} })
    await runJobSpawners(disabled.spawners)
    assert.equal(await runNextJob(disabled.handlers), false)
    assert.deepEqual(
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(unsupported.id),
      { state: 'waiting' },
    )

    let starts = 0
    const startRegistrations = {
      discover: () => {
        starts += 1
      },
    }
    startJobWorkers({ spawners: startRegistrations, handlers: {} })
    startJobWorkers({ spawners: startRegistrations, handlers: {} })
    assert.equal(starts, 1)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
