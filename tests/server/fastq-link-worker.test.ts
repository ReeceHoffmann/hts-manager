import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import type { FastqLinkReconcileResult } from '../../src/fastq-links/reconcile'
import { startFastqLinkWorker } from '../../src/server/fastq-link-worker'

const EMPTY_RESULT: FastqLinkReconcileResult = {
  created: 0,
  replaced: 0,
  removed: 0,
  unchanged: 0,
  directoriesCreated: 0,
  directoriesRemoved: 0,
}

test('reconciles immediately and schedules non-overlapping retries', async () => {
  const calls: Array<[string, string]> = []
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const errors: unknown[] = []
  let finishFirstReconcile: (() => void) | undefined

  const reconcile = (sourcePath: string, destinationPath: string) => {
    calls.push([sourcePath, destinationPath])

    if (calls.length === 1) {
      return new Promise<FastqLinkReconcileResult>((resolve) => {
        finishFirstReconcile = () => resolve(EMPTY_RESULT)
      })
    }

    return Promise.reject(new Error('reconcile failed'))
  }

  const dependencies = {
    reconcile,
    schedule: (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs })
    },
    onError: (error: unknown) => errors.push(error),
  }
  const config = {
    enabled: true as const,
    sourcePath: '/source',
    destinationPath: '/destination',
  }

  startFastqLinkWorker(config, dependencies)
  startFastqLinkWorker(config, dependencies)

  assert.deepEqual(calls, [['/source', '/destination']])
  assert.deepEqual(scheduled, [])

  assert.ok(finishFirstReconcile)
  finishFirstReconcile()
  await setImmediate()

  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0]?.delayMs, 30_000)

  scheduled[0]?.callback()
  await setImmediate()

  assert.deepEqual(calls, [
    ['/source', '/destination'],
    ['/source', '/destination'],
  ])
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /reconcile failed/)
  assert.equal(scheduled.length, 2)
  assert.equal(scheduled[1]?.delayMs, 30_000)
})
