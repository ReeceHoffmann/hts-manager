import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import type { FileRow } from '../../src/db/files'

type ReceivedRequest = {
  body: Buffer
  headers: IncomingHttpHeaders
  url: string
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('uploads the source file as the complete raw request body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htsm-uploader-'))
  const filename = 'reads file.fastq.gz'
  const path = join(directory, filename)
  const source = gzipSync(
    Buffer.from('@read-1\nACGTACGT\n+\nFFFFFFFF\n@read-2\nTGCATGCA\n+\nFFFFFFFF\n'),
  )
  writeFileSync(path, source)

  let resolveRequest!: (request: ReceivedRequest) => void
  const receivedRequest = new Promise<ReceivedRequest>((resolve) => {
    resolveRequest = resolve
  })

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      resolveRequest({
        body: Buffer.concat(chunks),
        headers: request.headers,
        url: request.url ?? '',
      })
      response.writeHead(201)
      response.end('{}')
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')

    process.env.VT_UPLOAD_URL = `http://127.0.0.1:${address.port}/uploads`
    process.env.VT_UPLOAD_USER_HANDLE = 'alice'
    process.env.VT_UPLOAD_API_KEY = 'secret'
    process.env.VT_UPLOAD_FILE_TYPE = 'reads'

    const { postFile } = await import('../../src/server/uploader')
    const row: FileRow = {
      id: 1,
      run_id: 1,
      path,
      name: filename,
      size: source.length,
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

    assert.equal(await postFile(row), 201)

    const received = await receivedRequest
    const url = new URL(received.url, process.env.VT_UPLOAD_URL)
    assert.equal(url.searchParams.get('name'), filename)
    assert.equal(url.searchParams.get('type'), 'reads')
    assert.equal(received.headers.authorization, 'Basic YWxpY2U6c2VjcmV0')
    assert.equal(received.headers['content-type'], 'application/octet-stream')
    assert.equal(received.headers['content-length'], String(source.length))
    assert.equal(received.body.length, source.length)
    assert.equal(sha256(received.body), sha256(source))
    assert.deepEqual(received.body, source)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
