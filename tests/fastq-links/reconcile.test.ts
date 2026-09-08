import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { reconcileFastqLinks } from '../../src/fastq-links/reconcile'

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
}

function makeFile(path: string): void {
  makeDirectory(dirname(path))
  writeFileSync(path, '')
}

function assertAbsoluteLink(path: string, target: string): void {
  assert.equal(lstatSync(path).isSymbolicLink(), true)
  assert.equal(readlinkSync(path), resolve(target))
}

test('creates NextSeq 500 links and persistent run directories', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-links-'))
  const source = join(directory, 'illumina')
  const destination = join(directory, 'links')
  const fastqDirectory = join(source, '190607', 'fastq')

  makeFile(join(fastqDirectory, 'sample.fastq.gz'))
  makeFile(join(fastqDirectory, 'sample.fq.gz'))
  makeFile(join(fastqDirectory, 'notes.txt'))
  makeFile(join(fastqDirectory, 'nested', 'ignored.fastq.gz'))
  makeDirectory(join(source, 'empty-run'))
  makeFile(join(source, 'loose.fastq.gz'))

  try {
    await reconcileFastqLinks(source, destination)

    assert.deepEqual(readdirSync(destination).sort(), ['190607', 'empty-run'])
    assert.deepEqual(readdirSync(join(destination, '190607')).sort(), [
      'sample.fastq.gz',
      'sample.fq.gz',
    ])
    assert.deepEqual(readdirSync(join(destination, 'empty-run')), [])
    assertAbsoluteLink(
      join(destination, '190607', 'sample.fastq.gz'),
      join(fastqDirectory, 'sample.fastq.gz'),
    )
    assertAbsoluteLink(
      join(destination, '190607', 'sample.fq.gz'),
      join(fastqDirectory, 'sample.fq.gz'),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('flattens one analysis and creates subdirectories for multiple analyses', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-links-'))
  const source = join(directory, 'illumina')
  const destination = join(directory, 'links')
  const singleFastq = join(
    source,
    'single-analysis',
    'Analysis',
    'alpha',
    'Data',
    'fastq',
  )
  const multiAlphaFastq = join(
    source,
    'multi-analysis',
    'Analysis',
    'alpha',
    'Data',
    'fastq',
  )
  const multiBetaFastq = join(
    source,
    'multi-analysis',
    'Analysis',
    'beta',
    'Data',
    'fastq',
  )

  makeFile(join(singleFastq, 'single.fastq.gz'))
  makeFile(join(source, 'single-analysis', 'fastq', 'ignored.fastq.gz'))
  makeFile(join(multiAlphaFastq, 'alpha.fastq.gz'))
  makeDirectory(multiBetaFastq)

  try {
    await reconcileFastqLinks(source, destination)

    assert.deepEqual(readdirSync(join(destination, 'single-analysis')), [
      'single.fastq.gz',
    ])
    assertAbsoluteLink(
      join(destination, 'single-analysis', 'single.fastq.gz'),
      join(singleFastq, 'single.fastq.gz'),
    )
    assert.deepEqual(
      readdirSync(join(destination, 'multi-analysis')).sort(),
      ['alpha', 'beta'],
    )
    assertAbsoluteLink(
      join(destination, 'multi-analysis', 'alpha', 'alpha.fastq.gz'),
      join(multiAlphaFastq, 'alpha.fastq.gz'),
    )
    assert.deepEqual(
      readdirSync(join(destination, 'multi-analysis', 'beta')),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciles changed links and one-to-many analysis transitions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-links-'))
  const source = join(directory, 'illumina')
  const destination = join(directory, 'links')
  const run = join(source, 'run')
  const alphaFastq = join(run, 'Analysis', 'alpha', 'Data', 'fastq')
  const betaFastq = join(run, 'Analysis', 'beta', 'Data', 'fastq')
  const alphaSource = join(alphaFastq, 'alpha.fastq.gz')
  const rootLink = join(destination, 'run', 'alpha.fastq.gz')

  makeFile(alphaSource)

  try {
    await reconcileFastqLinks(source, destination)
    const originalInode = lstatSync(rootLink).ino

    const unchanged = await reconcileFastqLinks(source, destination)
    assert.equal(unchanged.unchanged, 1)
    assert.equal(lstatSync(rootLink).ino, originalInode)

    unlinkSync(rootLink)
    symlinkSync('/missing/wrong.fastq.gz', rootLink)
    symlinkSync('/missing/stale.fastq.gz', join(destination, 'run', 'stale.fq.gz'))

    const repaired = await reconcileFastqLinks(source, destination)
    assert.equal(repaired.replaced, 1)
    assert.equal(repaired.removed, 1)
    assertAbsoluteLink(rootLink, alphaSource)

    rmSync(alphaSource)
    await reconcileFastqLinks(source, destination)
    assert.deepEqual(readdirSync(join(destination, 'run')), [])

    makeFile(alphaSource)
    makeFile(join(betaFastq, 'beta.fastq.gz'))
    await reconcileFastqLinks(source, destination)

    assert.deepEqual(readdirSync(join(destination, 'run')).sort(), [
      'alpha',
      'beta',
    ])
    assertAbsoluteLink(
      join(destination, 'run', 'alpha', 'alpha.fastq.gz'),
      alphaSource,
    )
    assertAbsoluteLink(
      join(destination, 'run', 'beta', 'beta.fastq.gz'),
      join(betaFastq, 'beta.fastq.gz'),
    )

    rmSync(run, { recursive: true })
    await reconcileFastqLinks(source, destination)
    assert.deepEqual(readdirSync(destination), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preserves regular-file conflicts and makes no destination changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-fastq-links-'))
  const source = join(directory, 'illumina')
  const destination = join(directory, 'links')

  makeFile(join(source, 'run', 'fastq', 'new.fastq.gz'))
  makeFile(join(destination, 'run', 'keep.txt'))
  symlinkSync('/missing/stale.fastq.gz', join(destination, 'stale.fastq.gz'))

  try {
    await assert.rejects(
      reconcileFastqLinks(source, destination),
      /refusing to reconcile FASTQ links over non-symlink entry/,
    )
    assert.equal(lstatSync(join(destination, 'run', 'keep.txt')).isFile(), true)
    assert.equal(
      lstatSync(join(destination, 'stale.fastq.gz')).isSymbolicLink(),
      true,
    )
    assert.equal(
      readdirSync(join(destination, 'run')).includes('new.fastq.gz'),
      false,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
