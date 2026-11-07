import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { isDeviceKeyEnvelope } from './device-key-envelope'
import { EntitlementService } from './entitlement.service'
import { KhQuantIdentityService } from './khquant-identity.service'
import { V2AuthGuard, type V2Request } from './v2-auth.guard'
import { V2AuthService } from './v2-auth.service'

// key_envelope of a computer that joined an account and waits for its key.
export const KEY_PENDING = 'pending'

@Controller('v2')
export class V2SessionController {
  constructor(
    private readonly identity: KhQuantIdentityService,
    private readonly database: DatabaseService,
    private readonly auth: V2AuthService,
    private readonly entitlement: EntitlementService,
  ) {}

  @Post('session/oauth/authorization')
  authorization(@Body() body: { codeChallenge: string; redirectUri: string }): object {
    return this.identity.beginAuthorization(body)
  }

  @Post('session/oauth/complete')
  async complete(@Body() body: { state: string; code: string; codeVerifier: string; deviceId: string; deviceName: string; publicKey: string; keyEnvelope?: string; deviceType?: 'desktop' | 'android'; clientVersion?: string }): Promise<object> {
    if (!body.deviceId || !body.deviceName || !body.publicKey) throw new BadRequestException('Device identity is required')
    const deviceType = body.deviceType === 'android' ? 'android' : 'desktop'
    const result = await this.identity.completeAuthorization(body)
    if (result.profile.disabled) throw new BadRequestException('This khLink account is disabled')
    const accountId = this.database.upsertAccount(result.profile)
    this.database.upsertEntitlement({ accountId, product: 'khquant', ...result.khQuantMembership })
    if (deviceType === 'android') {
      // A phone logs in with the khQuant account directly instead of scanning a
      // desktop QR. It is admitted only for an allowed (admin) account or an
      // account whose membership grants write access; the phone registers its
      // public key with no key envelope yet, and the always-online connector
      // wraps the account key to that key (see connector key-handoff endpoints).
      this.assertPhoneLoginAllowed(result.profile.subject, accountId)
      const phones = this.database.listAccountDevices(accountId).filter((device) => device.type === 'android' && device.id !== body.deviceId)
      if (phones.length >= 10) throw new BadRequestException('This account already has ten phones')
      this.database.upsertAccountDevice({ accountId, id: body.deviceId, name: body.deviceName, type: 'android', publicKey: body.publicKey })
      this.database.updateDeviceVersion(accountId, body.deviceId, body.clientVersion)
      return {
        profile: this.database.getAccount(accountId),
        entitlements: this.database.listEntitlements(accountId),
        effectiveEntitlement: this.entitlement.forAccount(accountId),
        session: this.auth.issue(accountId, body.deviceId, 'android'),
        keyPending: true,
      }
    }
    // One account may be used from several computers. The device identity is
    // stable per installation, so upserting the same id remains idempotent
    // while a new id adds another desktop/connector pair. All computers of an
    // account share one account key, so a phone reads every one of them: a
    // computer joining an account that already has one waits until a running
    // connector wraps that key to its public key (device-key v3, as for
    // phones), and only then starts its own connector.
    // Logging out of the desktop app and in with another account keeps the
    // computer's identity, which still belonged to the first account, so the
    // login failed with a 500. The same installation (same id and public key)
    // moves to the new account with its connector; any other claim on the id
    // is refused.
    const owner = this.database.findAccountDevice(body.deviceId)
    if (owner && owner.accountId !== accountId) {
      if (owner.type !== 'desktop' || owner.publicKey !== body.publicKey) throw new ConflictException('This computer is bound to another account')
      this.database.releaseDesktop(owner.accountId, body.deviceId)
    }
    const existing = this.database.getAccountDevice(accountId, body.deviceId)
    const others = this.database.listAccountDevices(accountId).filter((device) => !device.revokedAt
      && (device.type === 'desktop' || device.type === 'connector')
      && device.id !== body.deviceId && device.id !== `${body.deviceId}.connector`)
    const keyPending = others.length > 0 && !isDeviceKeyEnvelope(existing?.keyEnvelope)
      && (!existing || existing.keyEnvelope === KEY_PENDING || existing.publicKey !== body.publicKey)
    this.database.upsertAccountDevice({ accountId, id: body.deviceId, name: body.deviceName, type: 'desktop', publicKey: body.publicKey,
      keyEnvelope: keyPending ? KEY_PENDING : undefined })
    this.database.updateDeviceVersion(accountId, body.deviceId, body.clientVersion)
    return {
      profile: this.database.getAccount(accountId),
      entitlements: this.database.listEntitlements(accountId),
      effectiveEntitlement: this.entitlement.forAccount(accountId),
      session: this.auth.issue(accountId, body.deviceId, 'desktop'),
      ...(keyPending ? { keyPending: true } : {}),
    }
  }

  // Phone login gate. KH_LINK_ADMIN_SUBJECTS (comma-separated khQuant subjects)
  // is the admin allowlist: listed accounts may always attach a phone. When the
  // list is empty, any account whose membership grants write access is allowed.
  private assertPhoneLoginAllowed(subject: string, accountId: string): void {
    const admins = (process.env.KH_LINK_ADMIN_SUBJECTS || '').split(',').map((item) => item.trim()).filter(Boolean)
    if (admins.length > 0) {
      if (!admins.includes(subject)) throw new ForbiddenException('This khLink account is not allowed to use phone login')
      return
    }
    // With a free monthly allowance every account may sign in: one that used
    // up its month still sees its history and the usage that asks for a
    // membership, instead of a bare refusal.
    const entitlement = this.entitlement.forAccount(accountId)
    if (!entitlement.canWrite && entitlement.source !== 'free') throw new ForbiddenException('An active khLink membership is required for phone login')
  }

  // The phone polls this after login until the connector has wrapped the account
  // key to its public key. Returns the device's own encrypted key envelope.
  @Get('session/key-envelope') @UseGuards(V2AuthGuard)
  keyEnvelope(@Req() req: V2Request): object {
    if (req.accountClaims.type !== 'android' && req.accountClaims.type !== 'desktop') throw new ForbiddenException('Only a phone or a joining computer fetches its key envelope')
    const device = this.database.getAccountDevice(req.accountClaims.sub, req.accountClaims.deviceId)
    if (!device || device.revokedAt) throw new ForbiddenException('Device is not registered')
    // Previously QR pairing stored a v2 envelope in the same device row. Treat
    // that legacy value as pending so the connector replaces it with v3.
    return isDeviceKeyEnvelope(device.keyEnvelope) ? { keyEnvelope: device.keyEnvelope } : { pending: true }
  }

  // Connector key-handoff: list this account's phones that still need the
  // account key wrapped to their public key.
  @Get('connector/devices/pending-keys') @UseGuards(V2AuthGuard)
  pendingKeys(@Req() req: V2Request): object {
    if (req.accountClaims.type !== 'connector' && req.accountClaims.type !== 'desktop') throw new ForbiddenException('Only the connector provisions phone keys')
    const caller = req.accountClaims.deviceId.replace(/.connector$/, '')
    const devices = this.database.listAccountDevices(req.accountClaims.sub)
      .filter((device) => !device.revokedAt && device.publicKey && (
        (device.type === 'android' && !isDeviceKeyEnvelope(device.keyEnvelope))
        // A joining computer, never the caller's own desktop.
        || (device.type === 'desktop' && device.keyEnvelope === KEY_PENDING && device.id !== caller)))
      .map((device) => ({ deviceId: device.id, name: device.name, publicKey: device.publicKey, type: device.type }))
    return { devices }
  }

  // Connector uploads the wrapped account key for one phone.
  @Post('connector/devices/key') @UseGuards(V2AuthGuard)
  provideKey(@Req() req: V2Request, @Body() body: { deviceId: string; keyEnvelope: string }): object {
    if (req.accountClaims.type !== 'connector' && req.accountClaims.type !== 'desktop') throw new ForbiddenException('Only the connector provisions phone keys')
    if (!body.deviceId || !body.keyEnvelope || body.keyEnvelope.length > 8192) throw new BadRequestException('deviceId and key envelope are required')
    if (!isDeviceKeyEnvelope(body.keyEnvelope)) throw new BadRequestException('A valid device-key v3 envelope is required')
    const device = this.database.getAccountDevice(req.accountClaims.sub, body.deviceId)
    const joining = device?.type === 'desktop' && device.keyEnvelope === KEY_PENDING
    if (!device || (device.type !== 'android' && !joining) || device.revokedAt) throw new BadRequestException('Target phone is not registered')
    this.database.upsertAccountDevice({ accountId: req.accountClaims.sub, id: device.id, name: device.name, type: device.type, keyEnvelope: body.keyEnvelope })
    return { delivered: true }
  }

  @Post('session/refresh')
  refresh(@Body() body: { accountId: string; deviceId: string; refreshToken: string }): object {
    return this.auth.refresh(body.accountId, body.deviceId, body.refreshToken)
  }

  @Post('connector/session') @UseGuards(V2AuthGuard)
  connectorSession(@Req() req: V2Request, @Body() body: { deviceName?: string }): object {
    if (req.accountClaims.type !== 'desktop') throw new ForbiddenException('Only the desktop app can provision its connector')
    const connectorId = `${req.accountClaims.deviceId}.connector`
    const desktop = this.database.getAccountDevice(req.accountClaims.sub, req.accountClaims.deviceId)
    this.database.upsertAccountDevice({
      accountId: req.accountClaims.sub,
      id: connectorId,
      name: body.deviceName?.trim() || `${desktop?.name || 'KH Link'} Connector`,
      type: 'connector',
    })
    return this.auth.issue(req.accountClaims.sub, connectorId, 'connector')
  }

  @Get('account') @UseGuards(V2AuthGuard)
  account(@Req() req: V2Request): object {
    const accountId = req.accountClaims.sub
    return {
      profile: this.database.getAccount(accountId),
      entitlements: this.database.listEntitlements(accountId),
      effectiveEntitlement: this.entitlement.forAccount(accountId),
      devices: this.database.listAccountDevices(accountId),
    }
  }

  @Post('devices/revoke') @UseGuards(V2AuthGuard)
  revoke(@Req() req: V2Request, @Body() body: { deviceId: string }): object {
    if (body.deviceId === req.accountClaims.deviceId) throw new BadRequestException('Cannot revoke current device')
    this.database.revokeAccountDevice(req.accountClaims.sub, body.deviceId)
    return { revoked: true }
  }
}
