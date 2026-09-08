import { reconcileFastqLinks } from '../fastq-links/reconcile'
import type { FastqLinkConfig } from './config'

const RECONCILE_INTERVAL_MS = 30_000

type EnabledFastqLinkConfig = Extract<FastqLinkConfig, { enabled: true }>

type FastqLinkWorkerDependencies = {
  reconcile?: typeof reconcileFastqLinks
  schedule?: (callback: () => void, delayMs: number) => void
  onError?: (error: unknown) => void
}

let started = false

function scheduleTimeout(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
}

async function reconcileLoop(
  config: EnabledFastqLinkConfig,
  reconcile: typeof reconcileFastqLinks,
  schedule: (callback: () => void, delayMs: number) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await reconcile(config.sourcePath, config.destinationPath)
  } catch (error) {
    onError(error)
  } finally {
    schedule(
      () => void reconcileLoop(config, reconcile, schedule, onError),
      RECONCILE_INTERVAL_MS,
    )
  }
}

/** Start periodic FASTQ link reconciliation once for this server process. */
export function startFastqLinkWorker(
  config: EnabledFastqLinkConfig,
  {
    reconcile = reconcileFastqLinks,
    schedule = scheduleTimeout,
    onError = (error) =>
      console.error('FASTQ link reconciliation failed', error),
  }: FastqLinkWorkerDependencies = {},
): void {
  if (started) return
  started = true
  void reconcileLoop(config, reconcile, schedule, onError)
}
