import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from './admin.guard'
import { DatabaseService } from './database.service'
import { RelayGateway } from './relay.gateway'
import { EntitlementService } from './entitlement.service'
import { TrafficService, trafficMonth, trafficResetsAt } from './traffic.service'

import { StorageStatsCache } from './storage-stats'

@Controller('v2/admin')
@UseGuards(AdminGuard)
export class AdminController {
  private storage?: StorageStatsCache

  constructor(private readonly database: DatabaseService, private readonly relay: RelayGateway, private readonly entitlement: EntitlementService,
    private readonly traffic: TrafficService) {}

  @Post('query')
  query(@Body() body: { subject?: string; query?: string; offset?: number; limit?: number; module?: string }): object {
    if (body.module === 'downloads') return this.database.adminDownloadStats(body.offset, body.limit)
    if (body.module === 'traffic') return this.trafficStats(body.query, body.offset, body.limit)
    if (body.module === 'devices') {
      const result = this.database.adminAllDevices(body.query, body.offset, body.limit)
      return { ...result, devices: result.devices.map(device => ({ ...device, online: this.relay.accountDeviceOnline(device.accountId, device.id) })) }
    }
    const overview = this.database.adminAccounts(body.query, body.offset, body.limit)
    if (body.subject !== undefined) {
      this.subject(body.subject)
      const account = this.database.accountBySubject(body.subject)
      return { account: account || null, devices: account ? this.database.adminDevices(account.id).map(device => ({ ...device, online: this.relay.accountDeviceOnline(account.id, device.id) })) : [],
        entitlement: account ? this.entitlement.forAccount(account.id) : null,
        phoneLoginPolicy: (process.env.KH_LINK_ADMIN_SUBJECTS || '').trim() ? 'allowlist' : 'membership',
        phoneLoginAllowlisted: (process.env.KH_LINK_ADMIN_SUBJECTS || '').split(',').map(value => value.trim()).includes(body.subject) }
    }
    return { ...overview, accounts: overview.accounts.map(account => ({ ...account, entitlement: this.entitlement.forAccount(account.id), onlineDevices: this.relay.accountOnlineCount(account.id) })),
      onlineDevices: this.relay.accountOnlineCount(), connectorsOnline: this.relay.onlineConnectorCount(),
      phoneLoginPolicy: (process.env.KH_LINK_ADMIN_SUBJECTS || '').trim() ? 'allowlist' : 'membership' }
  }

  @Post('action')
  action(@Body() body: { subject: string; operation: string; deviceId?: string; actorSubject: string; reason: string; eventId: string; confirmed: boolean; policy?: object }): object {
    this.subject(body.subject)
    this.subject(body.actorSubject)
    if (!body.confirmed || !body.reason?.trim() || body.reason.length > 500 || !/^[a-zA-Z0-9_-]{16,96}$/.test(body.eventId || '')) throw new BadRequestException('Confirmation and reason required')
    if (!['ban', 'unban', 'revoke-device', 'revoke-all', 'release-policy'].includes(body.operation)) throw new BadRequestException('Unknown operation')
    const previous = this.database.adminResult(body.eventId)
    if (previous) {
      if (previous.subject !== body.subject || previous.operation !== body.operation || previous.actorSubject !== body.actorSubject || previous.deviceId !== (body.deviceId || null) || previous.reason !== body.reason || JSON.stringify(previous.policy || null) !== JSON.stringify(body.policy || null)) throw new BadRequestException('Event identity conflict')
      return previous
    }
    const account = this.database.accountBySubject(body.subject)
    if (!account && body.operation !== 'release-policy') throw new BadRequestException('Account has not used KH Link')
    if (body.operation === 'revoke-device' && (!body.deviceId || !this.database.adminDevices(account!.id).some(d => d.id === body.deviceId))) throw new BadRequestException('Device is not owned by this account')
    const result = this.database.applyAdminAction(body, account?.id)
    if (account && ['ban', 'revoke-all'].includes(body.operation)) this.relay.disconnectAccount(account.id)
    if (account && body.operation === 'revoke-device') this.relay.disconnectAccount(account.id, body.deviceId)
    return result
  }

  /**
   * Content traffic through this relay per account and month (heartbeats are
   * not counted), plus what the relay stores on disk for each account. The
   * storage figures come from an hourly background measurement.
   */
  private trafficStats(month?: string, offset?: number, limit?: number): object {
    this.traffic.flush()
    const now = Date.now()
    const current = trafficMonth(now)
    const wanted = /^\d{4}-\d{2}$/.test(month || '') ? month as string : current
    this.storage ||= new StorageStatsCache(this.database.path, () => this.database.adminStorage())
    const { stats: storage, measuring } = this.storage.current(now)
    const result = this.database.adminTraffic(wanted, offset, limit)
    const limitBytes = this.traffic.freeMonthlyBytes
    // Per-device split, counted from 2026-11-14: earlier days only have account totals.
    const devices = this.database.deviceTraffic(result.accounts.map(account => account.id), `${wanted}-01`, `${wanted}-31`)
    // What it was for, counted from 2026-11-15.
    const categories = this.database.categoryTraffic(result.accounts.map(account => account.id), `${wanted}-01`, `${wanted}-31`)
    return {
      month: wanted, currentMonth: current, limitBytes, resetsAt: trafficResetsAt(now),
      total: result.total, usedBytes: result.usedBytes, months: result.months, days: this.traffic.summary(31, now).days, limit: result.limit, offset: result.offset,
      accounts: result.accounts.map(account => {
        const entitlement = this.entitlement.forAccount(account.id)
        const member = entitlement.source !== 'free' && entitlement.canWrite
        const stored = storage?.accounts[account.id] || { historyBytes: null, eventBytes: null }
        return { ...account, member, overLimit: !member && limitBytes > 0 && wanted === current && account.usedBytes >= limitBytes, ...stored,
          devices: devices.filter(device => device.accountId === account.id).map(({ accountId: _, ...device }) => device),
          categories: categories.filter(row => row.accountId === account.id).map(({ accountId: _, ...row }) => row) }
      }),
      storage: storage ? { databaseBytes: storage.databaseBytes, historyBytes: storage.historyBytes, eventBytes: storage.eventBytes, measuredAt: storage.measuredAt, measuring }
        : { databaseBytes: null, historyBytes: null, eventBytes: null, measuredAt: null, measuring },
    }
  }

  private subject(value: string): void {
    if (!/^[1-9]\d{0,19}$/.test(value || '')) throw new BadRequestException('Invalid WordPress subject')
  }
}
