import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { FileRow } from '../../src/db/files'

type ReceivedRequest = {
  body: Buffer
  headers: IncomingHttpHeaders
  method: string
  url: string
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function row(path: string, name: string, size: number, id = 1): FileRow {
  return {
    id,
    run_id: 1,
    path,
    name,
    size,
    lane: 'L001',
    missing: 0,
    upload_requested: 1,
    uploaded: 0,
    upload_status: 'uploading',
    upload_error: null,
    uploaded_at: null,
    first_seen_at: '2026-09-02T00:00:00.000Z',
    last_scanned_at: '2026-09-02T00:00:00.000Z',
  }
}

test('uploads direct blocks and cancels failed reservations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-uploader-'))
  const source = Buffer.from('abcdefghijklm')
  const sourcePath = join(directory, 'reads.fastq.gz')
  writeFileSync(sourcePath, source)

  const received: ReceivedRequest[] = []
  const blocks = new Map<number, Map<string, Buffer>>()
  const names = new Map<number, string>()
  let nextUploadId = 1
  let activeBlocks = 0
  let maxActiveBlocks = 0
  let baseUrl = ''

  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    const item = {
      body,
      headers: request.headers,
      method: request.method ?? '',
      url: request.url ?? '',
    }
    received.push(item)
    const url = new URL(item.url, baseUrl)

    if (item.method === 'POST' && url.pathname === '/uploads') {
      const metadata = JSON.parse(body.toString()) as { name: string }
      if (metadata.name === 'init-failure.fastq.gz') {
        response.writeHead(503)
        response.end('initialization unavailable')
        return
      }
      const uploadId = nextUploadId++
      names.set(uploadId, metadata.name)
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          uploadId,
          url: `${baseUrl}/storage/${uploadId}?sv=2026-01-01&sig=signed-token-${uploadId}`,
          blockSize: 5,
          concurrency: 2,
        }),
      )
      return
    }

    const storageMatch = /^\/storage\/(\d+)$/.exec(url.pathname)
    if (item.method === 'PUT' && storageMatch) {
      const uploadId = Number(storageMatch[1])
      const name = names.get(uploadId)!
      if (url.searchParams.get('comp') === 'blocklist') {
        if (name === 'commit-failure.fastq.gz') {
          response.writeHead(403, { 'content-type': 'application/xml' })
          response.end('<Error><Code>InternalError</Code><Message>commit failed</Message></Error>')
        } else {
          response.writeHead(201)
          response.end()
        }
        return
      }

      activeBlocks += 1
      maxActiveBlocks = Math.max(maxActiveBlocks, activeBlocks)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeBlocks -= 1

      if (name === 'permanent-failure.fastq.gz') {
        response.writeHead(403, { 'content-type': 'application/xml' })
        response.end(
          `<Error><Code>AuthorizationFailure</Code><Message>${baseUrl}/storage/${uploadId}?sig=signed-token-${uploadId}</Message></Error>`,
        )
        return
      }
      const byUpload = blocks.get(uploadId) ?? new Map<string, Buffer>()
      byUpload.set(url.searchParams.get('blockid')!, body)
      blocks.set(uploadId, byUpload)
      response.writeHead(201)
      response.end()
      return
    }

    const finalizeMatch = /^\/uploads\/(\d+)\/finalize$/.exec(url.pathname)
    if (item.method === 'POST' && finalizeMatch) {
      if (names.get(Number(finalizeMatch[1])) === 'finalize-failure.fastq.gz') {
        response.writeHead(409)
        response.end('stored object is incomplete')
      } else {
        response.writeHead(200)
        response.end('{}')
      }
      return
    }

    if (item.method === 'DELETE' && /^\/uploads\/\d+$/.test(url.pathname)) {
      response.writeHead(204)
      response.end()
      return
    }

    response.writeHead(404)
    response.end('unexpected request')
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    baseUrl = `http://127.0.0.1:${address.port}`

    process.env.VT_UPLOAD_URL = `${baseUrl}/uploads`
    process.env.VT_UPLOAD_USER_HANDLE = 'alice'
    process.env.VT_UPLOAD_API_KEY = 'secret'
    process.env.VT_UPLOAD_FILE_TYPE = 'reads'
    process.env.HTSM_DB_PATH = join(directory, 'hts-manager.db')

    const { getDb, migrateDatabase } = await import('../../src/db/db')
    const { postFile, uploadOne } = await import('../../src/server/uploader')
    migrateDatabase()

    const happy = row(sourcePath, 'happy.fastq.gz', source.length)
    assert.equal(await postFile(happy), 200)
    const init = received.find(
      (item) => item.method === 'POST' && item.url === '/uploads',
    )!
    assert.equal(init.headers.authorization, 'Basic YWxpY2U6c2VjcmV0')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body.toString()), {
      name: happy.name,
      type: 'reads',
      size: source.length,
    })
    const finalize = received.find(
      (item) => item.method === 'POST' && item.url === '/uploads/1/finalize',
    )!
    assert.equal(finalize.headers.authorization, 'Basic YWxpY2U6c2VjcmV0')

    const happyId = 1
    const commit = received.find(
      (item) => item.method === 'PUT' && item.url.startsWith(`/storage/${happyId}?`) && item.url.includes('comp=blocklist'),
    )!
    assert.equal(commit.headers['content-type'], 'application/xml')
    assert.equal(commit.headers['x-ms-blob-content-type'], 'application/octet-stream')
    const orderedBlockIds = [...commit.body.toString().matchAll(/<Latest>([^<]+)<\/Latest>/g)].map(
      ([, id]) => id,
    )
    assert.equal(orderedBlockIds.length, 3)
    assert.ok(orderedBlockIds.every((id) => id.length > 0))
    assert.deepEqual(
      Buffer.concat(orderedBlockIds.map((id) => blocks.get(happyId)!.get(id)!)),
      source,
    )
    assert.deepEqual(
      orderedBlockIds.map((id) => blocks.get(happyId)!.get(id)!.length),
      [5, 5, 3],
    )
    assert.ok(maxActiveBlocks <= 2)

    let permanentError = ''
    await assert.rejects(
      async () => {
        try {
          await postFile(row(sourcePath, 'permanent-failure.fastq.gz', source.length, 3))
        } catch (error) {
          permanentError = error instanceof Error ? error.message : String(error)
          throw error
        }
      },
      Error,
    )
    assert.doesNotMatch(permanentError, /signed-token/)

    await assert.rejects(
      postFile(row(sourcePath, 'init-failure.fastq.gz', source.length, 4)),
      /HTTP 503/,
    )
    await assert.rejects(
      postFile(row(sourcePath, 'commit-failure.fastq.gz', source.length, 5)),
      /commit failed/,
    )
    await assert.rejects(
      postFile(row(sourcePath, 'finalize-failure.fastq.gz', source.length, 6)),
      /HTTP 409/,
    )

    const deletes = received.filter((item) => item.method === 'DELETE')
    assert.equal(deletes.length, 3)
    assert.ok(deletes.every((item) => item.headers.authorization === 'Basic YWxpY2U6c2VjcmV0'))

    const db = getDb()
    db.prepare(
      `INSERT INTO runs
        (id, run_folder, run_date, instrument, run_number, flowcell, first_seen_at, last_scanned_at)
       VALUES (1, 'run', '2026-09-02', 'instrument', '1', 'flowcell', 'now', 'now')`,
    ).run()
    db.prepare(
      `INSERT INTO files
        (id, run_id, path, name, size, lane, upload_requested, upload_status, first_seen_at, last_scanned_at)
       VALUES (?, 1, ?, ?, ?, 'L001', 1, 'queued', 'now', 'now')`,
    ).run(99, sourcePath, 'database-success.fastq.gz', source.length)
    const databaseRow = { ...row(sourcePath, 'database-success.fastq.gz', source.length, 99), upload_status: 'queued' as const }
    await uploadOne(databaseRow)
    assert.deepEqual(
      db.prepare('SELECT uploaded, upload_status, upload_error FROM files WHERE id = 99').get(),
      { uploaded: 1, upload_status: 'uploaded', upload_error: null },
    )

    for (const [id, name] of [
      [100, 'init-failure.fastq.gz'],
      [101, 'commit-failure.fastq.gz'],
      [102, 'finalize-failure.fastq.gz'],
    ] as const) {
      const failurePath = join(directory, `${id}.fastq.gz`)
      writeFileSync(failurePath, source)
      db.prepare(
        `INSERT INTO files
          (id, run_id, path, name, size, lane, upload_requested, upload_status, first_seen_at, last_scanned_at)
         VALUES (?, 1, ?, ?, ?, 'L001', 1, 'queued', 'now', 'now')`,
      ).run(id, failurePath, name, source.length)
      await uploadOne({
        ...row(failurePath, name, source.length, id),
        upload_status: 'queued',
      })
      const failed = db
        .prepare('SELECT uploaded, upload_status, upload_error FROM files WHERE id = ?')
        .get(id) as { uploaded: number; upload_status: string; upload_error: string }
      assert.equal(failed.uploaded, 0)
      assert.equal(failed.upload_status, 'error')
      assert.ok(failed.upload_error.length > 0)
    }
    assert.ok(
      received
        .filter((item) => item.url.startsWith('/storage/'))
        .every((item) => item.headers.authorization === undefined),
    )
    db.close()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
