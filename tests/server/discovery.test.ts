import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('discovers source runs and retries runtime failures through jobs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-discovery-'))
  const sourceRoot = join(directory, 'source')
  const destinationRoot = join(directory, 'destination')
  const databasePath = join(directory, 'hts-manager.db')
  mkdirSync(sourceRoot)
  mkdirSync(destinationRoot)

  process.env.HTSM_DB_PATH = databasePath
  process.env.HTSM_TRANSFER_SOURCE_PATH = sourceRoot
  process.env.HTSM_SCAN_PATH = destinationRoot

  const detectedName = '260101_NS123_0001_FLOW1'
  const readyName = '260102_NS123_0002_FLOW2'
  const markerDirectoryName = '260103_NS123_0003_FLOW3'
  const markerSymlinkName = '260104_NS123_0004_FLOW4'
  const manualName = '260105_NS123_0005_FLOW5'

  const detectedPath = join(sourceRoot, detectedName)
  const readyPath = join(sourceRoot, readyName)
  const markerDirectoryPath = join(sourceRoot, markerDirectoryName)
  const markerSymlinkPath = join(sourceRoot, markerSymlinkName)
  const manualPath = join(sourceRoot, manualName)

  mkdirSync(join(detectedPath, 'nested'), { recursive: true })
  writeFileSync(join(detectedPath, 'nested', 'CopyComplete.txt'), 'nested')
  mkdirSync(join(detectedPath, 'InterOp'))
  for (const decoy of [
    'RunInfo.xml',
    'RTAComplete.txt',
    'RunCompletionStatus.xml',
    'Manifest.tsv',
    'copycomplete.txt',
    'CopyComplete.txt.bak',
  ]) {
    writeFileSync(join(detectedPath, decoy), decoy)
  }

  mkdirSync(readyPath)
  writeFileSync(join(readyPath, 'CopyComplete.txt'), 'ready')

  mkdirSync(markerDirectoryPath)
  mkdirSync(join(markerDirectoryPath, 'CopyComplete.txt'))

  mkdirSync(markerSymlinkPath)
  writeFileSync(join(markerSymlinkPath, 'real-marker.txt'), 'not exact')
  symlinkSync(
    'real-marker.txt',
    join(markerSymlinkPath, 'CopyComplete.txt'),
  )

  mkdirSync(manualPath)
  mkdirSync(join(sourceRoot, '.260106_NS123_0006_HIDDEN'))
  mkdirSync(join(sourceRoot, 'not-a-run'))
  writeFileSync(join(sourceRoot, '260107_NS123_0007_FILE'), 'not a directory')
  symlinkSync(readyPath, join(sourceRoot, '260108_NS123_0008_SYMLINK'))

  const destinationFile = join(destinationRoot, manualName, 'sample.fastq.gz')
  mkdirSync(join(destinationRoot, manualName))
  writeFileSync(destinationFile, 'destination data')

  const { getDb, migrateDatabase } = await import('../../src/db/db')
  const { insertIfNew } = await import('../../src/db/files')
  const { getRunByFolder } = await import('../../src/db/runs')
  const { discoverSourceRuns } = await import('../../src/server/discovery')
  const {
    createJobRegistries,
    runJobSpawners,
    runNextJob,
  } = await import('../../src/server/job-worker')

  const { getConfig } = await import('../../src/server/config')
  const { spawners, handlers } = createJobRegistries(getConfig())

  migrateDatabase()
  const db = getDb()
  const getLatestDiscoveryJob = () =>
    db
      .prepare(
        `SELECT state, error_message FROM jobs
          WHERE kind = 'discover'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get() as { state: string; error_message: string | null } | undefined

  try {
    assert.equal(
      insertIfNew({
        path: destinationFile,
        name: 'sample.fastq.gz',
        size: 16,
        lane: null,
        run_folder: manualName,
        run_date: '2026-01-05',
        instrument: 'NS123',
        run_number: '0005',
        flowcell: 'FLOW5',
      }),
      true,
    )

    assert.deepEqual(await discoverSourceRuns(sourceRoot), {
      added: 4,
      known: 0,
      manual: 1,
      skipped: 4,
    })
    assert.equal(getRunByFolder(detectedName)?.transfer_status, 'detected')
    assert.equal(getRunByFolder(readyName)?.transfer_status, 'ready')
    assert.equal(
      getRunByFolder(markerDirectoryName)?.transfer_status,
      'detected',
    )
    assert.equal(
      getRunByFolder(markerSymlinkName)?.transfer_status,
      'detected',
    )
    assert.deepEqual(
      {
        status: getRunByFolder(manualName)?.transfer_status,
        sourcePath: getRunByFolder(manualName)?.source_path,
      },
      { status: 'manual', sourcePath: null },
    )

    assert.deepEqual(await discoverSourceRuns(sourceRoot), {
      added: 0,
      known: 4,
      manual: 1,
      skipped: 4,
    })

    writeFileSync(join(detectedPath, 'CopyComplete.txt'), 'ready now')
    await discoverSourceRuns(sourceRoot)
    assert.equal(getRunByFolder(detectedName)?.transfer_status, 'ready')

    assert.equal(readFileSync(destinationFile, 'utf8'), 'destination data')
    assert.equal(readFileSync(join(readyPath, 'CopyComplete.txt'), 'utf8'), 'ready')
    assert.deepEqual(
      db
        .prepare(
          `SELECT COUNT(*) AS count,
                  SUM(upload_requested) AS requested,
                  SUM(uploaded) AS uploaded
             FROM files`,
        )
        .get(),
      { count: 1, requested: 0, uploaded: 0 },
    )

    await runJobSpawners(spawners)
    await runJobSpawners(spawners)
    assert.deepEqual(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM jobs
            WHERE kind = 'discover' AND state = 'waiting'`,
        )
        .get(),
      { count: 1 },
    )
    assert.equal(await runNextJob(handlers), true)
    assert.equal(getLatestDiscoveryJob()?.state, 'complete')

    rmSync(sourceRoot, { recursive: true })
    await runJobSpawners(spawners)
    assert.equal(await runNextJob(handlers), true)
    const failedDiscovery = getLatestDiscoveryJob()
    assert.equal(failedDiscovery?.state, 'error')
    assert.match(
      failedDiscovery?.error_message ?? '',
      /ENOENT|no such file or directory/,
    )

    mkdirSync(sourceRoot)
    await runJobSpawners(spawners)
    assert.equal(await runNextJob(handlers), true)
    assert.equal(getLatestDiscoveryJob()?.state, 'complete')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
