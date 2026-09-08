/** Discover transfer-managed Illumina runs without walking their contents. */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getRunByFolder } from '../db/runs'
import { markRunReady, upsertDetectedRun } from '../db/transfer'
import { parseRunFolder } from '../scan/parse'

export type DiscoverySummary = {
  added: number
  known: number
  manual: number
  skipped: number
}

async function hasReadinessMarker(runPath: string): Promise<boolean> {
  try {
    return (await lstat(join(runPath, 'CopyComplete.txt'))).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

/**
 * Register recognized immediate child directories and promote detected runs
 * when their root-level CopyComplete.txt marker is a regular file.
 */
export async function discoverSourceRuns(
  sourceRoot: string,
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = {
    added: 0,
    known: 0,
    manual: 0,
    skipped: 0,
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (
      entry.name.startsWith('.') ||
      !entry.isDirectory() ||
      !parseRunFolder(entry.name)
    ) {
      summary.skipped += 1
      continue
    }

    const sourcePath = join(sourceRoot, entry.name)
    const ready = await hasReadinessMarker(sourcePath)
    const existing = getRunByFolder(entry.name)
    const run = upsertDetectedRun({
      runFolder: entry.name,
      sourcePath,
    })

    if (!existing) summary.added += 1
    else if (existing.transfer_status === 'manual') summary.manual += 1
    else summary.known += 1

    if (run.transfer_status === 'detected' && ready) {
      markRunReady(run.id)
    }
  }

  return summary
}
