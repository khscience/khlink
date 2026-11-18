import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseService } from './database.service'

/** One account's traffic through this relay in the current month (Beijing time). */
export interface TrafficUsage {
  month: string
  usedBytes: number
  /** 0 when this relay has no free monthly allowance. */
  limitBytes: number
  resetsAt: number
}

const BEIJING_OFFSET_MS = 8 * 3_600_000

/** "2026-11" for the month that contains `now` in Beijing time. */
export function trafficMonth(now = Date.now()): string {
  const local = new Date(now + BEIJING_OFFSET_MS)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`
}

/** "2026-11-13" for the day that contains `now` in Beijing time. */
export function trafficDay(now = Date.now()): string {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/** Relay-wide daily totals: no account appears in it. */
export interface DailyTrafficSummary {
  updatedAt: number
  timezone: 'Asia/Shanghai'
  /** Oldest first; days before counting started (2026-11-13) are absent, not zero. */
  days: Array<{ day: string; bytes: number; accounts: number }>
  month: { month: string; bytes: number; accounts: number }
  freeMonthlyBytes: number
}

/** When the month of `now` ends, in Beijing time: the next allowance starts then. */
export function trafficResetsAt(now = Date.now()): number {
  const local = new Date(now + BEIJING_OFFSET_MS)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - BEIJING_OFFSET_MS
}

/**
 * Counts what an account sends and receives through the official relay.
 * Only content counts (messages, commands, results, history, files): the
 * connector's presence and status heartbeats would otherwise use a free
 * account's month on their own. Counts are kept in memory and written in
 * batches; KH_LINK_FREE_MONTHLY_BYTES sets the free allowance (unset or 0: no
 * free use, as on self-hosted relays, which never count anything).
 */
@Injectable()
export class TrafficService implements OnModuleDestroy {
  readonly freeMonthlyBytes = Math.max(0, Number(process.env.KH_LINK_FREE_MONTHLY_BYTES || 0) || 0)
  /** Where the daily summary is written for the portal and the local center (unset: not written). */
  readonly summaryFile = (process.env.KH_LINK_TRAFFIC_SUMMARY_FILE || '').trim()
  private pending = new Map<string, number>()
  /** Per-device split of the same traffic, keyed account
day
device. */
  private pendingDevices = new Map<string, { up: number; down: number }>()
  /** What the same traffic was for, keyed account
day
category. */
  private pendingCategories = new Map<string, { up: number; down: number; requests: number }>()
  private timer: NodeJS.Timeout
  private summaryTimer?: NodeJS.Timeout

  constructor(private readonly database: DatabaseService) {
    this.timer = setInterval(() => this.flush(), 5_000)
    this.timer.unref?.()
    if (this.summaryFile) {
      this.summaryTimer = setInterval(() => this.writeSummary(), 10 * 60_000)
      this.summaryTimer.unref?.()
      setTimeout(() => this.writeSummary(), 30_000).unref?.()
    }
  }

  add(accountId: string, bytes: number, now = Date.now()): void {
    if (!accountId || !(bytes > 0)) return
    const key = `${accountId}
${trafficMonth(now)}
${trafficDay(now)}`
    this.pending.set(key, (this.pending.get(key) || 0) + Math.round(bytes))
  }

  /**
   * Attributes traffic to one device: `up` is what it sent, `down` what the
   * relay delivered to it. Callers count the account total with add(); the
   * split is only for finding which device uses the traffic.
   */
  addDevice(accountId: string, deviceId: string, up: number, down: number, now = Date.now()): void {
    if (!accountId || !deviceId || !(up > 0 || down > 0)) return
    const key = `${accountId}
${trafficDay(now)}
${deviceId}`
    const entry = this.pendingDevices.get(key) || { up: 0, down: 0 }
    entry.up += Math.max(0, Math.round(up) || 0); entry.down += Math.max(0, Math.round(down) || 0)
    this.pendingDevices.set(key, entry)
  }

  /**
   * Attributes traffic to what it was for (a live frame kind, a history upload
   * or read). Like addDevice, only a split of what add() counted.
   */
  addCategory(accountId: string, category: string, up: number, down: number, now = Date.now(), requests = 1): void {
    if (!accountId || !category || !(up > 0 || down > 0 || requests > 0)) return
    const key = `${accountId}\n${trafficDay(now)}\n${category.slice(0, 80)}`
    const entry = this.pendingCategories.get(key) || { up: 0, down: 0, requests: 0 }
    entry.up += Math.max(0, Math.round(up) || 0); entry.down += Math.max(0, Math.round(down) || 0); entry.requests += Math.max(0, requests)
    this.pendingCategories.set(key, entry)
  }

  usage(accountId: string, now = Date.now()): TrafficUsage {
    const month = trafficMonth(now)
    const stored = this.database.getAccountTraffic(accountId, month)
    let pending = 0
    for (const [key, bytes] of this.pending) if (key.startsWith(`${accountId}\n${month}\n`)) pending += bytes
    return { month, usedBytes: stored + pending, limitBytes: this.freeMonthlyBytes, resetsAt: trafficResetsAt(now) }
  }

  /** Whether an account without a membership may still use the relay this month. */
  withinFreeAllowance(accountId: string, now = Date.now()): boolean {
    return this.freeMonthlyBytes > 0 && this.usage(accountId, now).usedBytes < this.freeMonthlyBytes
  }

  flush(): void {
    if (this.pending.size) {
      const rows = [...this.pending].map(([key, bytes]) => { const [accountId, month, day] = key.split('\n'); return { accountId, month, day, bytes } })
      this.pending.clear()
      this.database.addAccountTraffic(rows)
    }
    if (this.pendingDevices.size) {
      const rows = [...this.pendingDevices].map(([key, { up, down }]) => { const [accountId, day, deviceId] = key.split('\n'); return { accountId, day, deviceId, up, down } })
      this.pendingDevices.clear()
      this.database.addDeviceTraffic(rows)
    }
    if (this.pendingCategories.size) {
      const rows = [...this.pendingCategories].map(([key, value]) => { const [accountId, day, category] = key.split('\n'); return { accountId, day, category, ...value } })
      this.pendingCategories.clear()
      this.database.addCategoryTraffic(rows)
    }
  }

  /** The last `days` days (Beijing time) of relay-wide traffic, after writing pending counts. */
  summary(days = 31, now = Date.now()): DailyTrafficSummary {
    this.flush()
    const month = trafficMonth(now)
    const totals = this.database.adminTraffic(month, 0, 1)
    return { updatedAt: now, timezone: 'Asia/Shanghai', days: this.database.dailyTraffic(trafficDay(now - (days - 1) * 86_400_000)),
      month: { month, bytes: totals.usedBytes, accounts: totals.total }, freeMonthlyBytes: this.freeMonthlyBytes }
  }

  /** Atomically replaces the summary file; a failure keeps the previous file. */
  writeSummary(now = Date.now()): void {
    if (!this.summaryFile) return
    try {
      mkdirSync(dirname(this.summaryFile), { recursive: true })
      const temporary = `${this.summaryFile}.tmp`
      writeFileSync(temporary, JSON.stringify(this.summary(31, now)), { mode: 0o644 })
      renameSync(temporary, this.summaryFile)
    } catch { /* the next run retries; counting is unaffected */ }
  }

  onModuleDestroy(): void { clearInterval(this.timer); if (this.summaryTimer) clearInterval(this.summaryTimer); this.flush(); this.writeSummary() }
}
