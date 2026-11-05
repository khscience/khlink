import { Injectable, UnauthorizedException } from '@nestjs/common'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseService } from './database.service'
import type { AccountAccessClaims, DeviceType } from './types'

const ACCESS_MS = 15 * 60_000
const REFRESH_MS = 30 * 24 * 60 * 60_000

function b64(value: Buffer | string): string { return Buffer.from(value).toString('base64url') }
function refreshHash(value: string): string { return createHmac('sha256', signingKey()).update(`v2|${value}`).digest('hex') }
function signingKey(): Buffer {
  const key = Buffer.from(process.env.TOKEN_SIGNING_KEY || '', 'base64')
  if (key.length < 32) throw new Error('TOKEN_SIGNING_KEY must be at least 32 random bytes in base64')
  return key
}

@Injectable()
export class V2AuthService {
  constructor(private readonly database: DatabaseService) {}

  private access(accountId: string, deviceId: string, type: DeviceType): { accessToken: string; expiresAt: number } {
    const claims: AccountAccessClaims = { sub: accountId, deviceId, type, exp: Date.now() + ACCESS_MS, version: 2 }
    const body = b64(JSON.stringify(claims))
    const accessToken = `${body}.${b64(createHmac('sha256', signingKey()).update(body).digest())}`
    return { accessToken, expiresAt: claims.exp }
  }

  issue(accountId: string, deviceId: string, type: DeviceType): object {
    const account = this.database.getAccount(accountId)
    if (!account || account.disabledAt || this.database.isAccountBanned(accountId)) throw new UnauthorizedException('Account revoked')
    const session = this.access(accountId, deviceId, type)
    const refreshToken = randomBytes(48).toString('base64url')
    this.database.setAccountRefresh(accountId, deviceId, refreshHash(refreshToken), Date.now() + REFRESH_MS)
    return { ...session, refreshToken, accountId, deviceId }
  }

  refresh(accountId: string, deviceId: string, token: string): object {
    const account = this.database.getAccount(accountId)
    if (!account || account.disabledAt || this.database.isAccountBanned(accountId)) throw new UnauthorizedException('Account revoked')
    const device = this.database.getAccountDevice(accountId, deviceId)
    if (!device || device.revokedAt || !device.refreshHash || (device.refreshExpiresAt || 0) < Date.now()) {
      throw new UnauthorizedException('Device revoked or refresh expired')
    }
    const actual = Buffer.from(refreshHash(token))
    const expected = Buffer.from(device.refreshHash)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Invalid refresh token')
    // Sliding window: a device in use keeps its login. A fixed 30 days from
    // sign-in logged every desktop, connector and phone out on day 30.
    this.database.extendAccountRefresh(accountId, deviceId, Date.now() + REFRESH_MS)
    return { ...this.access(accountId, deviceId, device.type), refreshToken: token, accountId, deviceId }
  }

  verify(token: string): AccountAccessClaims {
    const [body, signature] = token.split('.')
    if (!body || !signature) throw new UnauthorizedException('Malformed token')
    const expected = b64(createHmac('sha256', signingKey()).update(body).digest())
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid token')
    }
    let claims: AccountAccessClaims
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccountAccessClaims
    } catch {
      throw new UnauthorizedException('Malformed token')
    }
    if (!claims || claims.version !== 2 || typeof claims.sub !== 'string' || !claims.sub ||
      typeof claims.deviceId !== 'string' || !claims.deviceId ||
      !['desktop', 'android', 'connector'].includes(claims.type) ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw new UnauthorizedException('Malformed token')
    }
    if (claims.exp < Date.now()) throw new UnauthorizedException('Token expired')
    const device = this.database.getAccountDevice(claims.sub, claims.deviceId)
    const account = this.database.getAccount(claims.sub)
    if (!device || device.revokedAt || !account || account.disabledAt || this.database.isAccountBanned(claims.sub)) throw new UnauthorizedException('Account or device revoked')
    return claims
  }
}
