import { Injectable, OnModuleDestroy } from '@nestjs/common'
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
  private pending = new Map<string, number>()
  private timer: NodeJS.Timeout

  constructor(private readonly database: DatabaseService) {
    this.timer = setInterval(() => this.flush(), 5_000)
    this.timer.unref?.()
  }

  add(accountId: string, bytes: number, now = Date.now()): void {
    if (!accountId || !(bytes > 0)) return
    const key = `${accountId}\n${trafficMonth(now)}`
    this.pending.set(key, (this.pending.get(key) || 0) + Math.round(bytes))
  }

  usage(accountId: string, now = Date.now()): TrafficUsage {
    const month = trafficMonth(now)
    const stored = this.database.getAccountTraffic(accountId, month)
    const pending = this.pending.get(`${accountId}\n${month}`) || 0
    return { month, usedBytes: stored + pending, limitBytes: this.freeMonthlyBytes, resetsAt: trafficResetsAt(now) }
  }

  /** Whether an account without a membership may still use the relay this month. */
  withinFreeAllowance(accountId: string, now = Date.now()): boolean {
    return this.freeMonthlyBytes > 0 && this.usage(accountId, now).usedBytes < this.freeMonthlyBytes
  }

  flush(): void {
    if (!this.pending.size) return
    const rows = [...this.pending].map(([key, bytes]) => { const [accountId, month] = key.split('\n'); return { accountId, month, bytes } })
    this.pending.clear()
    this.database.addAccountTraffic(rows)
  }

  onModuleDestroy(): void { clearInterval(this.timer); this.flush() }
}
