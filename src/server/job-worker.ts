/** Registry-driven spawning and serial execution for persisted jobs. */
import {
  claimJob,
  type JobKind,
  type JobRow,
  updateJobState,
} from '../db/jobs'
import { queueDiscoveryJob } from '../db/transfer'
import { getConfig, type Config } from './config'
import { discoverSourceRuns } from './discovery'

export type JobSpawner = () => void | Promise<void>

export type JobHandler = (job: JobRow) => void | Promise<void>

export type JobSpawnerRegistry = Readonly<
  Partial<Record<JobKind, JobSpawner>>
>

export type JobHandlerRegistry = Readonly<
  Partial<Record<JobKind, JobHandler>>
>

export type JobRegistries = {
  spawners: JobSpawnerRegistry
  handlers: JobHandlerRegistry
}

/** Build matching spawners and handlers for the jobs enabled at startup. */
export function createJobRegistries(config: Config): JobRegistries {
  const spawners: Partial<Record<JobKind, JobSpawner>> = {}
  const handlers: Partial<Record<JobKind, JobHandler>> = {}
  const { enabled, sourcePath } = config.transfer

  if (enabled && sourcePath) {
    spawners.discover = queueDiscoveryJob
    handlers.discover = async () => {
      await discoverSourceRuns(sourcePath)
    }
  }

  return { spawners, handlers }
}

/** Fixed cadence for spawning and checking for newly queued work. */
const POLL_INTERVAL_MS = 30_000

let started = false

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() ? message : 'job handler failed without an error message'
}

/** Invoke every registered spawner once without letting one failure block another. */
export async function runJobSpawners(
  spawners: JobSpawnerRegistry,
): Promise<void> {
  const spawnerEntries = Object.entries(spawners) as [JobKind, JobSpawner][]
  for (const [kind, spawn] of spawnerEntries) {
    try {
      await spawn()
    } catch (error) {
      console.error(`job spawner failed for kind ${kind}`, error)
    }
  }
}

/**
 * Claim and process the oldest job supported by the universal worker.
 * Returns whether a job was processed so the runner can drain the queue.
 */
export async function runNextJob(
  handlers: JobHandlerRegistry,
): Promise<boolean> {
  const handlerEntries = Object.entries(handlers) as [JobKind, JobHandler][]
  const job = claimJob(handlerEntries.map(([kind]) => kind))
  if (!job) return false

  const handler = handlerEntries.find(([kind]) => kind === job.kind)?.[1]
  if (!handler) {
    throw new Error(`claimed job ${job.id} without a handler for ${job.kind}`)
  }

  try {
    await handler(job)
  } catch (error) {
    updateJobState(job.id, 'error', errorMessage(error))
    return true
  }

  updateJobState(job.id, 'complete')
  return true
}

function schedule(nextCycle: () => Promise<void>): void {
  const timer = setTimeout(() => void nextCycle(), POLL_INTERVAL_MS)
  timer.unref()
}

async function spawnerLoop(spawners: JobSpawnerRegistry): Promise<void> {
  await runJobSpawners(spawners)
  schedule(() => spawnerLoop(spawners))
}

async function runnerLoop(handlers: JobHandlerRegistry): Promise<void> {
  try {
    while (await runNextJob(handlers)) {
      // Drain all currently waiting supported jobs serially before polling again.
    }
  } catch (error) {
    // Database/state-transition failures should not permanently stop the worker.
    console.error('job runner failed', error)
  }
  schedule(() => runnerLoop(handlers))
}

/** Start the spawner and universal runner loops once for this server process. */
export function startJobWorkers(registries?: JobRegistries): void {
  if (started) return
  const { spawners, handlers } = registries ?? createJobRegistries(getConfig())
  started = true
  if (Object.keys(spawners).length) void spawnerLoop(spawners)
  if (Object.keys(handlers).length) void runnerLoop(handlers)
}
