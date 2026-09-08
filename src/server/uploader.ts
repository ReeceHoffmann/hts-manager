/**
 * Background uploader singleton. A single serial loop drains the upload queue:
 * it claims the next requested file, POSTs it whole to Virtool, and marks it
 * `uploaded` on HTTP 201 or `error` (retryable) otherwise. Only one upload runs
 * at a time. On restart, a row left `uploading` by a dead process is re-claimed
 * first and re-POSTed whole — Virtool has no resumable upload, so "resume" is a
 * fresh POST of the interrupted file. See plan.md (step 6).
 *
 * Virtool's upload route stores the request body directly, so the FASTQ stream
 * must be the complete body: HTTP Basic auth, `name`/`type` query params,
 * `application/octet-stream`, success = 201.
 */
import { createReadStream } from 'node:fs'
import { request } from 'undici'
import {
  claimNext,
  getUploadCounts,
  markError,
  markUploaded,
  setUploading,
} from '../db/uploads'
import type { FileRow } from '../db/files'
import { getUploadConfig } from './config'

/** Snapshot of the uploader, surfaced through `getStatus`. */
export interface UploadState {
  /** True while a file is actively being POSTed. */
  uploading: boolean
  /** Id of the file currently uploading, or null when idle. */
  currentId: number | null
  /** Name of the file currently uploading, or null when idle. */
  currentName: string | null
  /** Files waiting in the queue (read fresh from the DB). */
  queued: number
  /** Files whose last attempt errored (read fresh from the DB). */
  errors: number
}

/** Idle poll interval when the queue is empty. */
const IDLE_DELAY_MS = 3_000
/** Backoff after an errored upload: `BASE * 2^(n-1)`, capped at `MAX`. */
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000

let state: { uploading: boolean; currentId: number | null; currentName: string | null } = {
  uploading: false,
  currentId: null,
  currentName: null,
}

/** Consecutive failures of the same row, used to grow the retry backoff. */
let consecutiveErrors = 0
let lastErrorId: number | null = null

/** Guards the singleton loop so {@link startUploader} runs it exactly once. */
let started = false

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Current uploader snapshot. The `queued`/`errors` counts come from the DB on
 * every call (not the in-memory loop) so they remain correct after a restart.
 */
export function getUploadState(): UploadState {
  const { queued, errors } = getUploadCounts()
  return { ...state, queued, errors }
}

/**
 * Stream one file to Virtool as the raw request body and return the HTTP status.
 * The explicit length lets the receiver verify that the complete indexed file
 * arrived without buffering the FASTQ in memory.
 */
export async function postFile(row: FileRow): Promise<number> {
  const { url, type, userHandle, apiKey } = getUploadConfig()
  const authorization = `Basic ${Buffer.from(`${userHandle}:${apiKey}`).toString('base64')}`

  const response = await request(url, {
    method: 'POST',
    query: { name: row.name, type },
    headers: {
      authorization,
      'content-type': 'application/octet-stream',
      'content-length': String(row.size),
    },
    body: createReadStream(row.path),
  })

  // Drain the body so the connection is released back to the pool.
  await response.body.text()
  return response.statusCode
}

/** Record a failed upload and back off before the loop re-claims the same row. */
async function recordError(id: number, message: string): Promise<void> {
  markError(id, message)
  consecutiveErrors = id === lastErrorId ? consecutiveErrors + 1 : 1
  lastErrorId = id
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveErrors - 1))
  await sleep(backoff)
}

/** Upload a single claimed row, updating live state and DB flags. */
async function uploadOne(row: FileRow): Promise<void> {
  setUploading(row.id)
  state = { uploading: true, currentId: row.id, currentName: row.name }
  try {
    const status = await postFile(row)
    if (status === 201) {
      markUploaded(row.id)
      consecutiveErrors = 0
      lastErrorId = null
    } else {
      await recordError(row.id, `upload failed: HTTP ${status}`)
    }
  } catch (err) {
    await recordError(row.id, err instanceof Error ? err.message : String(err))
  } finally {
    state = { uploading: false, currentId: null, currentName: null }
  }
}

/** Serial drain loop: claim → upload → repeat, idling when the queue is empty. */
async function uploaderLoop(): Promise<void> {
  for (;;) {
    let row: FileRow | undefined
    try {
      row = claimNext()
    } catch (err) {
      // A transient DB error shouldn't kill the loop; back off and retry.
      console.error('uploader: claimNext failed', err)
      await sleep(IDLE_DELAY_MS)
      continue
    }

    if (!row) {
      await sleep(IDLE_DELAY_MS)
      continue
    }

    await uploadOne(row)
  }
}

/** Start the upload loop (idempotent — safe to call from bootstrap repeatedly). */
export function startUploader(): void {
  if (started) return
  started = true
  void uploaderLoop()
}
