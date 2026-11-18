// Measures what the relay stores per account in a worker thread with its own
// read-only connection: on the production database the scan takes over a
// minute (2026-11-13: 81 s cold), which must never block the relay's event loop.
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { measureStorage } from './storage-stats'

const db = new Database(workerData.path as string, { readonly: true, fileMustExist: true })
try {
  parentPort!.postMessage({ ok: true, value: measureStorage(db) })
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
} finally {
  db.close()
}
