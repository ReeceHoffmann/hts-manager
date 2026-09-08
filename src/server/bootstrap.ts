/**
 * One-time startup hook for the in-process background workers. The Nitro startup
 * plugin calls {@link ensureWorkersStarted} after configuration validation and
 * database migration. A `globalThis` flag prevents duplicate loops if Nitro is
 * initialized more than once in the same process.
 */
import { requestScan } from './scanner'
import { startJobWorkers } from './job-worker'
import { startUploader } from './uploader'

declare global {
  // eslint-disable-next-line no-var
  var __htsmWorkersStarted: boolean | undefined
}

/**
 * Start the scanner and uploader loops (and kick off the startup scan) once per
 * process. Job registries select the work enabled by configuration. Subsequent
 * calls are no-ops.
 */
export function ensureWorkersStarted(): void {
  if (globalThis.__htsmWorkersStarted) return

  globalThis.__htsmWorkersStarted = true

  // Startup scan; a no-op if HTSM_SCAN_PATH is unset (reason: 'no-scan-path').
  requestScan()
  startUploader()
  startJobWorkers()
}
