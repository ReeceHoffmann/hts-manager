import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ZodError } from 'zod'
import { readConfig } from '../../src/server/config'

test('uses the direct Virtool upload endpoint and supported upload types', () => {
  assert.equal(
    readConfig({}).upload.url,
    'https://preview.virtool.ca/api/v1/uploads',
  )
  for (const type of ['reference', 'reads', 'subtraction']) {
    assert.equal(readConfig({ VT_UPLOAD_FILE_TYPE: type }).upload.type, type)
  }
  assert.throws(
    () => readConfig({ VT_UPLOAD_FILE_TYPE: 'unknown' }),
    /VT_UPLOAD_FILE_TYPE/,
  )
})

test('uses the source path to enable managed transfer', () => {
  assert.deepEqual(readConfig({}).transfer, {
    enabled: false,
    sourcePath: null,
    destinationPath: null,
    removeAfterDays: null,
  })

  const directory = mkdtempSync(join(tmpdir(), 'htsm-transfer-config-'))
  const sourcePath = join(directory, 'source')
  const destinationPath = join(directory, 'destination')
  mkdirSync(sourcePath)
  mkdirSync(destinationPath)

  try {
    assert.deepEqual(
      readConfig({
        HTSM_TRANSFER_SOURCE_PATH: sourcePath,
        HTSM_SCAN_PATH: destinationPath,
      }).transfer,
      {
        enabled: true,
        sourcePath,
        destinationPath,
        removeAfterDays: null,
      },
    )
    assert.equal(
      readConfig({
        HTSM_TRANSFER_SOURCE_PATH: sourcePath,
        HTSM_SCAN_PATH: destinationPath,
        HTSM_TRANSFER_REMOVE_AFTER_DAYS: '0',
      }).transfer.removeAfterDays,
      0,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normalizes omitted removal retention to null', () => {
  assert.equal(readConfig({}).transfer.removeAfterDays, null)
})

test('enables FASTQ symlink reconciliation with an absolute destination', () => {
  assert.deepEqual(readConfig({}).fastqLinks, {
    enabled: false,
    sourcePath: null,
    destinationPath: null,
  })

  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-link-config-'))
  const sourcePath = join(directory, 'illumina')
  const destinationPath = join(directory, 'fastq')
  mkdirSync(sourcePath)

  try {
    assert.deepEqual(
      readConfig({
        HTSM_SCAN_PATH: sourcePath,
        HTSM_FASTQ_SYMLINK_PATH: destinationPath,
      }).fastqLinks,
      {
        enabled: true,
        sourcePath,
        destinationPath,
      },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects invalid FASTQ symlink source and destination combinations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-link-config-'))
  const sourcePath = join(directory, 'illumina')
  mkdirSync(sourcePath)

  try {
    assert.throws(
      () => readConfig({ HTSM_FASTQ_SYMLINK_PATH: '/mnt/raw/fastq' }),
      /HTSM_SCAN_PATH is required when HTSM_FASTQ_SYMLINK_PATH is set/,
    )
    assert.throws(
      () =>
        readConfig({
          HTSM_SCAN_PATH: sourcePath,
          HTSM_FASTQ_SYMLINK_PATH: 'relative/fastq',
        }),
      /HTSM_FASTQ_SYMLINK_PATH must be absolute/,
    )
    assert.throws(
      () =>
        readConfig({
          HTSM_SCAN_PATH: sourcePath,
          HTSM_FASTQ_SYMLINK_PATH: join(sourcePath, 'fastq'),
        }),
      /must be distinct and not nested/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects invalid source-removal retention values', () => {
  for (const value of ['-1', '1.5', 'not-a-number']) {
    assert.throws(
      () => readConfig({ HTSM_TRANSFER_REMOVE_AFTER_DAYS: value }),
      /HTSM_TRANSFER_REMOVE_AFTER_DAYS/,
    )
  }
})

test('reports cross-field transfer errors through Zod', () => {
  assert.throws(
    () => readConfig({ HTSM_TRANSFER_REMOVE_AFTER_DAYS: '7' }),
    (error) =>
      error instanceof ZodError &&
      error.issues.some(
        (issue) =>
          issue.path.join('.') === 'HTSM_TRANSFER_REMOVE_AFTER_DAYS' &&
          issue.message ===
            'HTSM_TRANSFER_REMOVE_AFTER_DAYS requires HTSM_TRANSFER_SOURCE_PATH',
      ),
  )
})
