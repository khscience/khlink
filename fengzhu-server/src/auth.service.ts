import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common'
import { createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseService } from './database.service'
import type { AccessClaims, DeviceType } from './types'

const ACCESS_MS = 15 * 60_000
const REFRESH_MS = 30 * 24 * 60 * 60_000
const ITERATIONS = 310_000

function b64(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function hash(value: string): string {
  return createHmac('sha256', 'fengzhu-refresh-v1').update(value).digest('hex')
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly challenges = new Map<string, { nonce: string; expires: number }>()
  private signingKey!: Buffer

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    this.signingKey = Buffer.from(process.env.TOKEN_SIGNING_KEY || '', 'base64')
    if (this.signingKey.length < 32) throw new Error('TOKEN_SIGNING_KEY must be at least 32 random bytes in base64')
    if (!this.database.getAuth()) {
      const password = process.env.FENGZHU_ADMIN_PASSWORD
      if (!password || password.length < 16) throw new Error('First start requires FENGZHU_ADMIN_PASSWORD with at least 16 characters')
      const salt = randomBytes(16)
      const verifier = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
      this.database.createAuth(salt.toString('base64'), verifier.toString('base64'), ITERATIONS)
    }
  }

  challenge(): object {
    const auth = this.database.getAuth()!
    const id = randomUUID()
    const nonce = randomBytes(32).toString('base64')
    this.challenges.set(id, { nonce, expires: Date.now() + 5 * 60_000 })
    return { challengeId: id, nonce, salt: auth.salt, iterations: auth.iterations, algorithm: 'PBKDF2-HMAC-SHA256' }
  }

  login(input: { challengeId: string; proof: string; deviceId: string; deviceName: string; deviceType: DeviceType; publicKey?: string; keyEnvelope?: { nonce: string; ciphertext: string } }): object {
    const challenge = this.challenges.get(input.challengeId)
    this.challenges.delete(input.challengeId)
    if (!challenge || challenge.expires < Date.now()) throw new UnauthorizedException('Challenge expired')
    const verifier = Buffer.from(this.database.getAuth()!.verifier, 'base64')
    const expected = createHmac('sha256', verifier).update(`${input.challengeId}|${challenge.nonce}`).digest()
    const actual = Buffer.from(input.proof || '', 'base64')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Invalid proof')
    if (!input.deviceId || !input.deviceName || !['android', 'connector'].includes(input.deviceType)) {
      throw new UnauthorizedException('Invalid device')
    }
    this.database.upsertDevice({ id: input.deviceId, name: input.deviceName, type: input.deviceType, publicKey: input.publicKey })
    let auth = this.database.getAuth()!
    if (!auth.keyNonce && input.keyEnvelope && input.deviceType === 'connector') {
      if (input.keyEnvelope.nonce.length > 128 || input.keyEnvelope.ciphertext.length > 1024) throw new UnauthorizedException('Invalid key envelope')
      this.database.setKeyEnvelope(input.keyEnvelope.nonce, input.keyEnvelope.ciphertext); auth = this.database.getAuth()!
    }
    if (!auth.keyNonce || !auth.keyCiphertext) throw new UnauthorizedException('Connector enrollment is required')
    return { ...this.issue(input.deviceId, input.deviceType), keyEnvelope: { nonce: auth.keyNonce, ciphertext: auth.keyCiphertext } }
  }

  changePassword(input: { salt: string; verifier: string; iterations: number; keyEnvelope: { nonce: string; ciphertext: string } }): object {
    if (input.iterations < 310_000 || Buffer.from(input.salt, 'base64').length < 16 || Buffer.from(input.verifier, 'base64').length !== 32) {
      throw new UnauthorizedException('Invalid password material')
    }
    this.database.changeAuth(input.salt, input.verifier, input.iterations, input.keyEnvelope.nonce, input.keyEnvelope.ciphertext)
    return { changed: true }
  }

  refresh(deviceId: string, refreshToken: string): object {
    const device = this.database.getDevice(deviceId)
    if (!device || device.revokedAt || !device.refresh_hash || (device.refresh_expires_at || 0) < Date.now()) {
      throw new UnauthorizedException('Device revoked or refresh expired')
    }
    const actual = Buffer.from(hash(refreshToken))
    const expected = Buffer.from(device.refresh_hash)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Invalid refresh token')
    return this.issue(device.id, device.type)
  }

  verifyAccess(token: string): AccessClaims {
    const [body, signature] = token.split('.')
    if (!body || !signature) throw new UnauthorizedException('Malformed token')
    const expected = b64(createHmac('sha256', this.signingKey).update(body).digest())
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid token')
    }
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims
    const device = this.database.getDevice(claims.deviceId)
    if (claims.exp < Date.now() || !device || device.revokedAt) throw new UnauthorizedException('Token expired or revoked')
    return claims
  }

  private issue(deviceId: string, type: DeviceType): object {
    const claims: AccessClaims = { sub: 'admin', deviceId, type, exp: Date.now() + ACCESS_MS }
    const body = b64(JSON.stringify(claims))
    const accessToken = `${body}.${b64(createHmac('sha256', this.signingKey).update(body).digest())}`
    const refreshToken = randomBytes(48).toString('base64url')
    this.database.setRefresh(deviceId, hash(refreshToken), Date.now() + REFRESH_MS)
    return { accessToken, refreshToken, expiresAt: claims.exp, deviceId }
  }
}
