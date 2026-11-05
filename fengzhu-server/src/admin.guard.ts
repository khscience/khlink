import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseService } from './database.service'

export function serviceSecret(name: string): string {
  const file = process.env[`${name}_FILE`]
  return file ? readFileSync(file, 'utf8').trim() : process.env[name] || ''
}

export function adminSignature(secret: string, method: string, path: string, timestamp: string, nonce: string, body: unknown): string {
  return createHmac('sha256', secret).update([method.toUpperCase(), path, timestamp, nonce, JSON.stringify(body || {})].join('\n')).digest('hex')
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    const allowedIps = (process.env.KH_LINK_ADMIN_ALLOWED_IPS || '').split(',').map(value => value.trim()).filter(Boolean)
    if (allowedIps.length && !allowedIps.includes(String(request.headers['x-real-ip'] || request.socket?.remoteAddress || ''))) throw new UnauthorizedException('Administration source is not allowed')
    const timestamp = String(request.headers['x-khlink-timestamp'] || '')
    const nonce = String(request.headers['x-khlink-nonce'] || '')
    const signature = String(request.headers['x-khlink-admin-signature'] || '')
    const secret = serviceSecret('KH_LINK_ADMIN_SECRET')
    if (secret.length < 32 || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !/^[a-zA-Z0-9_-]{24,96}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new UnauthorizedException('Invalid administration request')
    const path = String(request.originalUrl || request.url).split('?')[0]
    const expected = adminSignature(secret, request.method, path, timestamp, nonce, request.body)
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) || !this.database.claimAdminNonce(nonce, Number(timestamp) * 1000)) {
      throw new UnauthorizedException('Invalid or replayed administration request')
    }
    return true
  }
}
