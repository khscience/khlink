import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common'
import { AdminGuard } from './admin.guard'
import { DatabaseService } from './database.service'
import { RelayGateway } from './relay.gateway'
import { EntitlementService } from './entitlement.service'

@Controller('v2/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly database: DatabaseService, private readonly relay: RelayGateway, private readonly entitlement: EntitlementService) {}

  @Post('query')
  query(@Body() body: { subject?: string; query?: string; offset?: number; limit?: number; module?: string }): object {
    if (body.module === 'downloads') return this.database.adminDownloadStats(body.offset, body.limit)
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

  private subject(value: string): void {
    if (!/^[1-9]\d{0,19}$/.test(value || '')) throw new BadRequestException('Invalid WordPress subject')
  }
}
