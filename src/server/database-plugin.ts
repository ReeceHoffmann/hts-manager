import { definePlugin } from 'nitro'
import { migrateDatabase } from '../db/db'
import { ensureWorkersStarted } from './bootstrap'
import { getConfig } from './config'

/** Prepare storage and start background workers before Nitro accepts requests. */
export default definePlugin(() => {
  const config = getConfig()
  migrateDatabase()
  ensureWorkersStarted(config)
})
