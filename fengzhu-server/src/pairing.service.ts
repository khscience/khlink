import { BadRequestException, Injectable } from '@nestjs/common'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseService } from './database.service'

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function validPublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/_=-]{40,64}$/.test(value)) return false
  try { return Buffer.from(value, 'base64').length === 32 } catch { return false }
}

// A pairing QR is still one-time and server-validated, but ninety seconds is
// too short for a real phone scan (especially when the user opens the album
// picker or waits for the desktop confirmation). Keep the window bounded
// while allowing the complete scan -> confirm -> poll flow to finish.
export const PAIRING_TTL_MS = 10 * 60_000

@Injectable()
export class PairingService {
  constructor(private readonly database: DatabaseService) {}

  create(accountId: string, desktopDeviceId: string): object {
    this.database.cleanupExpiredPairings()
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.database.createPairing({ id, accountId, desktopDeviceId, secretHash: hash(secret), expiresAt })
    // The desktop puts its own relay address in the QR code; server is informational.
    return { id, secret, expiresAt, ...(process.env.KH_LINK_PUBLIC_URL ? { server: process.env.KH_LINK_PUBLIC_URL } : {}) }
  }

  verifySecret(pairing: Record<string, unknown>, secret: string): void {
    const account = this.database.getAccount(String(pairing.accountId))
    if (!account || account.disabledAt || this.database.isAccountBanned(account.id)) throw new BadRequestException('Account is revoked')
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new BadRequestException('Pairing code is invalid or expired')
    }
    const actual = Buffer.from(hash(secret))
    const expected = Buffer.from(String(pairing.secretHash || ''))
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new BadRequestException('Pairing code is invalid or expired')
    }
    if (Number(pairing.expiresAt) <= Date.now()) {
      this.database.expirePairing(String(pairing.id))
      throw new BadRequestException('Pairing code is invalid or expired')
    }
  }

  claim(input: { id: string; secret: string; deviceId: string; deviceName: string; publicKey: string }): object {
    if (!input.id || !input.deviceId || !input.deviceName || !input.secret || !validPublicKey(input.publicKey)) {
      throw new BadRequestException('Valid phone identity and public key are required')
    }
    const pairing = this.database.getPairing(input.id)
    if (!pairing) throw new BadRequestException('Pairing code not found')
    this.verifySecret(pairing, input.secret)
    const accountId = String(pairing.accountId)
    const owner = this.database.findAccountDevice(input.deviceId)
    if (owner && owner.accountId !== accountId) throw new BadRequestException('This phone is already bound to another account')
    const phones = this.database.listAccountDevices(accountId).filter((device) => device.type === 'android' && device.id !== input.deviceId)
    if (phones.length >= 10) throw new BadRequestException('This account already has ten phones')
    if (!this.database.claimPairing(input)) throw new BadRequestException('Pairing code has already been claimed')
    return { status: 'pending', accountId }
  }

  status(accountId: string, id: string): object {
    const pairing = this.database.getPairing(id)
    if (!pairing || pairing.accountId !== accountId) throw new BadRequestException('Pairing code not found')
    return { id, status: pairing.status, deviceId: pairing.androidDeviceId, deviceName: pairing.androidDeviceName, publicKey: pairing.androidPublicKey, expiresAt: pairing.expiresAt }
  }

  confirm(accountId: string, id: string, keyEnvelope: string): object {
    if (!keyEnvelope || keyEnvelope.length > 8192) throw new BadRequestException('Encrypted key envelope is required')
    if (!this.database.confirmPairing(id, accountId, keyEnvelope)) throw new BadRequestException('Pairing is not awaiting confirmation')
    return { confirmed: true }
  }

  consume(id: string, secret: string): Record<string, unknown> | null {
    const pairing = this.database.getPairing(id)
    if (!pairing) throw new BadRequestException('Pairing code not found')
    this.verifySecret(pairing, secret)
    if (pairing.status === 'consumed') throw new BadRequestException('Pairing was already consumed')
    if (pairing.status !== 'confirmed') return null
    const completed = this.database.completePairing(id)
    if (!completed) throw new BadRequestException('Pairing was already consumed')
    return completed
  }
}
