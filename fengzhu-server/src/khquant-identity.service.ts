import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import type { KhQuantMembership, KhQuantProfile, MembershipState } from './types'

type OAuthConfig = {
  issuer: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  profileUrl: string
  entitlementUrl: string
}

type PendingAuthorization = { codeChallenge: string; redirectUri: string; expiresAt: number }

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function validateRedirectUri(value: string): string {
  let redirect: URL
  try { redirect = new URL(value) } catch { throw new UnauthorizedException('Invalid redirect URI') }
  if (redirect.username || redirect.password || redirect.hash) throw new UnauthorizedException('Invalid redirect URI')
  // Desktop uses a loopback http callback; that is always allowed.
  if (redirect.protocol === 'http:' && isLoopback(redirect.hostname)) return redirect.toString()
  // Everything else (an HTTPS callback, or a mobile custom-scheme callback like
  // khlink://oauth/callback for the phone login) must be an exact allowlist match.
  const allowed = (process.env.KH_LINK_ALLOWED_REDIRECT_URIS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (allowed.includes(redirect.toString())) return redirect.toString()
  throw new UnauthorizedException('Redirect URI must be a loopback callback or an explicitly configured URI')
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new ServiceUnavailableException(`KH Link identity is unavailable: ${name} is not configured`)
  return value
}

export function normalizeMembership(value: unknown): KhQuantMembership {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const state = String(raw.state ?? raw.status ?? 'unavailable').toLowerCase()
  const mapped: Record<string, MembershipState> = {
    active: 'active', valid: 'active', expiring: 'expiring', expiring_soon: 'expiring',
    expired: 'expired', payment_pending: 'payment_pending', pending: 'payment_pending',
    account_exception: 'account_exception', disabled: 'account_exception', unavailable: 'unavailable',
  }
  const expires = Number(raw.expiresAt ?? raw.expires_at ?? raw.expiry)
  return {
    state: mapped[state] || 'unavailable',
    plan: typeof raw.plan === 'string' ? raw.plan : undefined,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : undefined,
  }
}

@Injectable()
export class KhQuantIdentityService {
  private readonly pending = new Map<string, PendingAuthorization>()

  configured(): boolean {
    return ['KHQUANT_OIDC_ISSUER', 'KHQUANT_OIDC_CLIENT_ID', 'KHQUANT_OIDC_AUTHORIZE_URL', 'KHQUANT_OIDC_TOKEN_URL', 'KHQUANT_OIDC_PROFILE_URL', 'KHQUANT_OIDC_ENTITLEMENT_URL']
      .every((name) => Boolean(process.env[name]?.trim()))
  }

  beginAuthorization(input: { codeChallenge: string; redirectUri: string }): { state: string; authorizationUrl: string; expiresAt: number } {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) throw new UnauthorizedException('Invalid PKCE code challenge')
    const redirectUri = validateRedirectUri(input.redirectUri)
    const config = this.config()
    const state = randomUUID()
    const expiresAt = Date.now() + 5 * 60_000
    this.pending.set(state, { codeChallenge: input.codeChallenge, redirectUri, expiresAt })
    const url = new URL(config.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('scope', 'openid profile membership')
    return { state, authorizationUrl: url.toString(), expiresAt }
  }

  async completeAuthorization(input: { state: string; code: string; codeVerifier: string }): Promise<{ profile: KhQuantProfile; khQuantMembership: KhQuantMembership }> {
    const pending = this.pending.get(input.state)
    this.pending.delete(input.state)
    if (!pending || pending.expiresAt < Date.now()) throw new UnauthorizedException('Authorization session expired')
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new UnauthorizedException('Invalid PKCE verifier')
    const expected = createHash('sha256').update(input.codeVerifier).digest('base64url')
    if (expected !== pending.codeChallenge) throw new UnauthorizedException('PKCE verification failed')
    const config = this.config()
    const token = await this.exchangeCode(config, input.code, input.codeVerifier, pending.redirectUri)
    const [profile, membership] = await Promise.all([this.profile(config, token), this.membership(config, token)])
    return { profile, khQuantMembership: membership }
  }

  private config(): OAuthConfig {
    return {
      issuer: required('KHQUANT_OIDC_ISSUER'), clientId: required('KHQUANT_OIDC_CLIENT_ID'),
      authorizeUrl: required('KHQUANT_OIDC_AUTHORIZE_URL'), tokenUrl: required('KHQUANT_OIDC_TOKEN_URL'),
      profileUrl: required('KHQUANT_OIDC_PROFILE_URL'), entitlementUrl: required('KHQUANT_OIDC_ENTITLEMENT_URL'),
    }
  }

  private async exchangeCode(config: OAuthConfig, code: string, codeVerifier: string, redirectUri: string): Promise<string> {
    const response = await fetch(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, code_verifier: codeVerifier, redirect_uri: redirectUri }) })
    if (!response.ok) throw new UnauthorizedException('Account authorization exchange failed')
    const body = await response.json() as { access_token?: string }
    if (!body.access_token) throw new UnauthorizedException('Account authorization response is invalid')
    return body.access_token
  }

  private async profile(config: OAuthConfig, token: string): Promise<KhQuantProfile> {
    const response = await fetch(config.profileUrl, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new UnauthorizedException('Account profile lookup failed')
    const body = await response.json() as Record<string, unknown>
    const subject = String(body.sub ?? body.id ?? '')
    if (!subject) throw new UnauthorizedException('Account profile has no subject')
    return { subject, displayName: String(body.name ?? body.nickname ?? subject), avatarUrl: typeof body.picture === 'string' ? body.picture : undefined,
      disabled: Boolean(body.disabled ?? body.accountDisabled) }
  }

  private async membership(config: OAuthConfig, token: string): Promise<KhQuantMembership> {
    const response = await fetch(config.entitlementUrl, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) return { state: 'unavailable' }
    return normalizeMembership(await response.json())
  }
}
