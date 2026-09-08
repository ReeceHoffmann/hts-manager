/**
 * Background uploader singleton. A single serial loop drains the upload queue.
 * Each file is initialized with Virtool, streamed directly to its signed blob URL
 * in blocks, committed, and then finalized with Virtool. Only one file runs at a
 * time; block concurrency applies within that file. Interrupted uploads restart
 * from initialization, since their signed URLs and reservations are disposable.
 */
import { BlockBlobClient } from '@azure/storage-blob'
import { request } from 'undici'
import { z } from 'zod'
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
export type UploadState = {
  uploading: boolean
  currentId: number | null
  currentName: string | null
  queued: number
  errors: number
}

const initResponseSchema = z.object({
  uploadId: z.number().int().positive(),
  url: z.url(),
  blockSize: z.number().int().positive(),
  concurrency: z.number().int().positive(),
})

type UploadInstructions = z.infer<typeof initResponseSchema>

const IDLE_DELAY_MS = 3_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000

let state: { uploading: boolean; currentId: number | null; currentName: string | null } = {
  uploading: false,
  currentId: null,
  currentName: null,
}
let consecutiveErrors = 0
let lastErrorId: number | null = null
let started = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function authorizationHeader(userHandle: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${userHandle}:${apiKey}`).toString('base64')}`
}

/** Remove signed URL queries and credentials from persisted failure details. */
function sanitizeDetail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      try {
        const url = new URL(match)
        return `${url.origin}${url.pathname}`
      } catch {
        return match.replace(/\?.*$/, '')
      }
    })
    .replace(
      /(["']?(?:authorization|api[_ -]?key|password|token)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sig|se|sp|sv)=[^\s,;"']+/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function sanitizeError(err: unknown): string {
  return sanitizeDetail(err instanceof Error ? err.message : String(err)) || 'upload failed'
}

function responseError(operation: string, status: number, body: string): Error {
  const detail = sanitizeDetail(body)
  return new Error(
    `${operation} failed: HTTP ${status}${detail ? ` (${detail})` : ''}`,
  )
}

async function responseText(response: Awaited<ReturnType<typeof request>>): Promise<string> {
  return response.body.text()
}

async function initializeUpload(row: FileRow): Promise<UploadInstructions> {
  const { url, type, userHandle, apiKey } = getUploadConfig()
  const response = await request(url, {
    method: 'POST',
    headers: {
      authorization: authorizationHeader(userHandle, apiKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: row.name, type, size: row.size }),
  })
  const body = await responseText(response)
  if (response.statusCode !== 201) {
    throw responseError('upload initialization', response.statusCode, body)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('upload initialization failed: invalid JSON response')
  }
  const result = initResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('upload initialization failed: invalid upload instructions')
  }
  return result.data
}

async function uploadToBlob(instructions: UploadInstructions, row: FileRow): Promise<void> {
  const blob = new BlockBlobClient(instructions.url)
  try {
    await blob.uploadFile(row.path, {
      blockSize: instructions.blockSize,
      concurrency: instructions.concurrency,
      // Prevent the SDK's 256 MiB single-PUT default so Virtool's direct block
      // transfer remains consistent for every non-empty file.
      maxSingleShotSize: 0,
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    })
  } catch (err) {
    throw new Error(sanitizeError(err))
  }
}

async function finalizeUpload(uploadId: number): Promise<number> {
  const { url, userHandle, apiKey } = getUploadConfig()
  const response = await request(`${url.replace(/\/+$/, '')}/${uploadId}/finalize`, {
    method: 'POST',
    headers: { authorization: authorizationHeader(userHandle, apiKey) },
  })
  const body = await responseText(response)
  if (response.statusCode !== 200) {
    throw responseError('upload finalization', response.statusCode, body)
  }
  return response.statusCode
}

async function cancelUpload(uploadId: number): Promise<void> {
  const { url, userHandle, apiKey } = getUploadConfig()
  const response = await request(`${url.replace(/\/+$/, '')}/${uploadId}`, {
    method: 'DELETE',
    headers: { authorization: authorizationHeader(userHandle, apiKey) },
  })
  await responseText(response)
}

/** Upload one indexed file through Virtool's direct upload protocol. */
export async function postFile(row: FileRow): Promise<number> {
  const instructions = await initializeUpload(row)
  try {
    await uploadToBlob(instructions, row)
    return await finalizeUpload(instructions.uploadId)
  } catch (err) {
    await cancelUpload(instructions.uploadId).catch(() => {})
    throw err
  }
}

/** Current uploader snapshot, with queue/error counts read fresh from SQLite. */
export function getUploadState(): UploadState {
  const { queued, errors } = getUploadCounts()
  return { ...state, queued, errors }
}

async function recordError(id: number, message: string): Promise<void> {
  markError(id, sanitizeDetail(message) || 'upload failed')
  consecutiveErrors = id === lastErrorId ? consecutiveErrors + 1 : 1
  lastErrorId = id
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveErrors - 1))
  await sleep(backoff)
}

/** Upload a claimed row, updating live state and the database lifecycle. */
export async function uploadOne(row: FileRow): Promise<void> {
  setUploading(row.id)
  state = { uploading: true, currentId: row.id, currentName: row.name }
  try {
    await postFile(row)
    markUploaded(row.id)
    consecutiveErrors = 0
    lastErrorId = null
  } catch (err) {
    await recordError(row.id, sanitizeError(err))
  } finally {
    state = { uploading: false, currentId: null, currentName: null }
  }
}

async function uploaderLoop(): Promise<void> {
  for (;;) {
    let row: FileRow | undefined
    try {
      row = claimNext()
    } catch (err) {
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

/** Start the uploader loop once; repeated bootstrap calls are safe. */
export function startUploader(): void {
  if (started) return
  started = true
  void uploaderLoop()
}
