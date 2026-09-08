import type { Dirent } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isFastqGz } from '../scan/parse'

type DesiredTree = {
  /** Directory paths relative to the destination root. */
  directories: Set<string>
  /** Destination-relative link paths mapped to absolute source paths. */
  links: Map<string, string>
}

type ExistingTree = {
  /** Directory paths relative to the destination root. */
  directories: Set<string>
  /** Destination-relative link paths mapped to their recorded targets. */
  links: Map<string, string>
}

export type FastqLinkReconcileResult = {
  created: number
  replaced: number
  removed: number
  unchanged: number
  directoriesCreated: number
  directoriesRemoved: number
}

/**
 * Reconcile a simplified tree of absolute FASTQ symlinks from Illumina runs.
 *
 * Direct child directories of `sourceRoot` are treated as runs. A run with one
 * NextSeq 1000 analysis is flattened into its destination run directory; runs
 * with multiple analyses get one real subdirectory per analysis. Runs without
 * analyses use the NextSeq 500 `<run>/fastq` layout.
 *
 * The destination is preflighted before mutation. Symlinks, empty directories,
 * and directories containing only those entry types are managed. Any regular
 * or special file aborts reconciliation so user data is never deleted.
 */
export async function reconcileFastqLinks(
  sourceRoot: string,
  destinationRoot: string,
): Promise<FastqLinkReconcileResult> {
  const source = resolve(sourceRoot)
  const destination = resolve(destinationRoot)

  assertSeparateTrees(source, destination)

  const desired = await discoverDesiredTree(source)
  const existing = await inspectDestination(destination)

  const result: FastqLinkReconcileResult = {
    created: 0,
    replaced: 0,
    removed: 0,
    unchanged: 0,
    directoriesCreated: 0,
    directoriesRemoved: 0,
  }

  const linksToCreate = new Map<string, string>()

  for (const [path, target] of existing.links) {
    const desiredTarget = desired.links.get(path)

    if (desiredTarget === target) {
      result.unchanged += 1
      continue
    }

    await unlink(join(destination, path))

    if (desiredTarget) {
      result.replaced += 1
      linksToCreate.set(path, desiredTarget)
    } else {
      result.removed += 1
    }
  }

  for (const [path, target] of desired.links) {
    if (!existing.links.has(path)) linksToCreate.set(path, target)
  }

  const obsoleteDirectories = [...existing.directories]
    .filter((path) => !desired.directories.has(path))
    .sort((a, b) => pathDepth(b) - pathDepth(a))

  for (const path of obsoleteDirectories) {
    await rmdir(join(destination, path))
    result.directoriesRemoved += 1
  }

  const missingDirectories = [...desired.directories]
    .filter((path) => !existing.directories.has(path))
    .sort((a, b) => pathDepth(a) - pathDepth(b))

  if (!existing.rootExists) {
    await mkdir(destination, { recursive: true })
  }

  for (const path of missingDirectories) {
    await mkdir(join(destination, path))
    result.directoriesCreated += 1
  }

  for (const [path, target] of linksToCreate) {
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await symlink(target, join(destination, path))
    if (!existing.links.has(path)) result.created += 1
  }

  return result
}

async function discoverDesiredTree(source: string): Promise<DesiredTree> {
  const directories = new Set<string>()
  const links = new Map<string, string>()
  const runEntries = await readdir(source, { withFileTypes: true })

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue

    const runName = runEntry.name
    const runPath = join(source, runName)
    directories.add(runName)

    const analysisEntries = await readDirectories(join(runPath, 'Analysis'))

    if (analysisEntries.length === 0) {
      await addFastqLinks(join(runPath, 'fastq'), runName, links)
      continue
    }

    if (analysisEntries.length === 1) {
      await addFastqLinks(
        join(runPath, 'Analysis', analysisEntries[0]!, 'Data', 'fastq'),
        runName,
        links,
      )
      continue
    }

    for (const analysisName of analysisEntries) {
      const destinationDirectory = join(runName, analysisName)
      directories.add(destinationDirectory)
      await addFastqLinks(
        join(runPath, 'Analysis', analysisName, 'Data', 'fastq'),
        destinationDirectory,
        links,
      )
    }
  }

  return { directories, links }
}

async function addFastqLinks(
  sourceDirectory: string,
  destinationDirectory: string,
  links: Map<string, string>,
): Promise<void> {
  const entries = await readDirectoryIfPresent(sourceDirectory)

  for (const entry of entries) {
    if (!entry.isFile() || !isFastqGz(entry.name)) continue
    links.set(
      join(destinationDirectory, entry.name),
      resolve(sourceDirectory, entry.name),
    )
  }
}

async function readDirectories(path: string): Promise<string[]> {
  const entries = await readDirectoryIfPresent(path)
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function readDirectoryIfPresent(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

async function inspectDestination(
  destination: string,
): Promise<ExistingTree & { rootExists: boolean }> {
  let rootStat
  try {
    rootStat = await lstat(destination)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        rootExists: false,
        directories: new Set(),
        links: new Map(),
      }
    }
    throw error
  }

  if (!rootStat.isDirectory()) {
    throw new Error(
      `FASTQ symlink destination is not a directory: ${destination}`,
    )
  }

  const directories = new Set<string>()
  const links = new Map<string, string>()

  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name

      if (entry.isDirectory()) {
        directories.add(relativePath)
        await walk(fullPath, relativePath)
      } else if (entry.isSymbolicLink()) {
        links.set(relativePath, await readlink(fullPath))
      } else {
        throw new Error(
          `refusing to reconcile FASTQ links over non-symlink entry: ${fullPath}`,
        )
      }
    }
  }

  await walk(destination, '')
  return { rootExists: true, directories, links }
}

function assertSeparateTrees(source: string, destination: string): void {
  if (
    source === destination ||
    isNestedPath(source, destination) ||
    isNestedPath(destination, source)
  ) {
    throw new Error('FASTQ symlink source and destination must not overlap')
  }
}

function isNestedPath(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return result !== '' && !result.startsWith('..') && !isAbsolute(result)
}

function pathDepth(path: string): number {
  return path.split(sep).length
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
