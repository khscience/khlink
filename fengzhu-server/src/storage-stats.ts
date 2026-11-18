import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type BetterSqlite3 from 'better-sqlite3'

export interface StorageStats {
  databaseBytes: number
  historyBytes: number
  eventBytes: number
  /** Stored (encrypted) bytes per account id. */
  accounts: Record<string, { historyBytes: number; eventBytes: number }>
}

/** What the relay keeps on disk: the database file and each account's stored history and pending events. */
export function measureStorage(db: BetterSqlite3.Database): StorageStats {
  const pages = db.pragma('page_count', { simple: true }) as number
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const accounts: StorageStats['accounts'] = {}
  let historyBytes = 0; let eventBytes = 0
  for (const row of db.prepare('SELECT account_id AS id, SUM(length(ciphertext)) AS bytes FROM account_history_items_v2 GROUP BY account_id').all() as Array<{ id: string; bytes: number }>) {
    accounts[row.id] = { historyBytes: row.bytes || 0, eventBytes: 0 }; historyBytes += row.bytes || 0
  }
  for (const row of db.prepare('SELECT account_id AS id, SUM(length(ciphertext)) AS bytes FROM account_events_v2 GROUP BY account_id').all() as Array<{ id: string; bytes: number }>) {
    accounts[row.id] = { historyBytes: accounts[row.id]?.historyBytes || 0, eventBytes: row.bytes || 0 }; eventBytes += row.bytes || 0
  }
  return { databaseBytes: pages * pageSize, historyBytes, eventBytes, accounts }
}

/**
 * Keeps the last measurement and refreshes it in the background at most once
 * an hour. Callers get what is known now (null before the first one finishes).
 * Without the compiled worker (tests run the TypeScript) it measures inline.
 */
export class StorageStatsCache {
  private value: (StorageStats & { measuredAt: number }) | null = null
  private running: Promise<void> | null = null

  constructor(private readonly path: string, private readonly inline: () => StorageStats, private readonly maxAgeMs = 60 * 60_000) {}

  current(now = Date.now()): { stats: (StorageStats & { measuredAt: number }) | null; measuring: boolean } {
    if (!this.running && (!this.value || now - this.value.measuredAt > this.maxAgeMs)) this.running = this.refresh().finally(() => { this.running = null })
    return { stats: this.value, measuring: !!this.running }
  }

  /** Resolves when the measurement in progress (if any) is done. */
  settled(): Promise<void> { return this.running || Promise.resolve() }

  private async refresh(): Promise<void> {
    const worker = join(__dirname, 'storage-stats.worker.js')
    if (!existsSync(worker)) { this.value = { ...this.inline(), measuredAt: Date.now() }; return }
    const result = await new Promise<{ ok: boolean; value?: StorageStats; error?: string }>((resolve) => {
      const thread = new Worker(worker, { workerData: { path: this.path } })
      thread.once('message', resolve)
      thread.once('error', (error) => resolve({ ok: false, error: error.message }))
      thread.once('exit', (code) => { if (code !== 0) resolve({ ok: false, error: `exit ${code}` }) })
    })
    if (result.ok && result.value) this.value = { ...result.value, measuredAt: Date.now() }
  }
}
