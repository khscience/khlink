import { createHash } from 'node:crypto'
import { KhQuantIdentityService, normalizeMembership } from '../src/khquant-identity.service'

describe('KH Link khQuant identity boundary', () => {
  const keys = ['KHQUANT_OIDC_ISSUER', 'KHQUANT_OIDC_CLIENT_ID', 'KHQUANT_OIDC_AUTHORIZE_URL', 'KHQUANT_OIDC_TOKEN_URL', 'KHQUANT_OIDC_PROFILE_URL', 'KHQUANT_OIDC_ENTITLEMENT_URL'] as const
  const previous = new Map(keys.map((key) => [key, process.env[key]]))

  afterEach(() => {
    keys.forEach((key) => {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  })

  it('does not advertise OAuth when the official khQuant endpoints are absent', () => {
    keys.forEach((key) => delete process.env[key])
    expect(new KhQuantIdentityService().configured()).toBe(false)
  })

  it('creates a one-time OAuth 2.1 PKCE authorization URL without an account password', () => {
    Object.assign(process.env, {
      KHQUANT_OIDC_ISSUER: 'https://accounts.example.test', KHQUANT_OIDC_CLIENT_ID: 'kh-link-desktop',
      KHQUANT_OIDC_AUTHORIZE_URL: 'https://accounts.example.test/oauth/authorize', KHQUANT_OIDC_TOKEN_URL: 'https://accounts.example.test/oauth/token',
      KHQUANT_OIDC_PROFILE_URL: 'https://accounts.example.test/userinfo', KHQUANT_OIDC_ENTITLEMENT_URL: 'https://accounts.example.test/entitlements',
    })
    const verifier = 'a'.repeat(64)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const result = new KhQuantIdentityService().beginAuthorization({ codeChallenge: challenge, redirectUri: 'http://127.0.0.1:45123/callback' })
    expect(result.authorizationUrl).toContain('code_challenge_method=S256')
    expect(result.authorizationUrl).toContain('client_id=kh-link-desktop')
    expect(result.authorizationUrl).not.toContain('password')
  })

  it('rejects non-loopback HTTP callbacks and unconfigured HTTPS callbacks', () => {
    Object.assign(process.env, {
      KHQUANT_OIDC_ISSUER: 'https://accounts.example.test', KHQUANT_OIDC_CLIENT_ID: 'kh-link-desktop',
      KHQUANT_OIDC_AUTHORIZE_URL: 'https://accounts.example.test/oauth/authorize', KHQUANT_OIDC_TOKEN_URL: 'https://accounts.example.test/oauth/token',
      KHQUANT_OIDC_PROFILE_URL: 'https://accounts.example.test/userinfo', KHQUANT_OIDC_ENTITLEMENT_URL: 'https://accounts.example.test/entitlements',
    })
    const service = new KhQuantIdentityService()
    const challenge = 'a'.repeat(43)
    expect(() => service.beginAuthorization({ codeChallenge: challenge, redirectUri: 'http://example.com/callback' })).toThrow('loopback')
    expect(() => service.beginAuthorization({ codeChallenge: challenge, redirectUri: 'https://example.com/callback' })).toThrow('loopback')
    // A mobile custom-scheme callback is rejected unless it is explicitly allowlisted.
    expect(() => service.beginAuthorization({ codeChallenge: challenge, redirectUri: 'khlink://oauth/callback' })).toThrow('loopback')
  })

  it('allows an explicitly allowlisted mobile custom-scheme callback (khlink://)', () => {
    Object.assign(process.env, {
      KHQUANT_OIDC_ISSUER: 'https://accounts.example.test', KHQUANT_OIDC_CLIENT_ID: 'kh-link-desktop',
      KHQUANT_OIDC_AUTHORIZE_URL: 'https://accounts.example.test/oauth/authorize', KHQUANT_OIDC_TOKEN_URL: 'https://accounts.example.test/oauth/token',
      KHQUANT_OIDC_PROFILE_URL: 'https://accounts.example.test/userinfo', KHQUANT_OIDC_ENTITLEMENT_URL: 'https://accounts.example.test/entitlements',
      KH_LINK_ALLOWED_REDIRECT_URIS: 'khlink://oauth/callback , https://relay.example.test/bridge/oauth/mobile',
    })
    const service = new KhQuantIdentityService()
    const challenge = 'a'.repeat(43)
    const result = service.beginAuthorization({ codeChallenge: challenge, redirectUri: 'khlink://oauth/callback' })
    expect(result.authorizationUrl).toContain(encodeURIComponent('khlink://oauth/callback'))
    delete process.env.KH_LINK_ALLOWED_REDIRECT_URIS
  })

  it('maps entitlement states to the product lifecycle states', () => {
    expect(normalizeMembership({ status: 'valid', plan: 'VIP', expires_at: 123 }).state).toBe('active')
    expect(normalizeMembership({ state: 'payment_pending' }).state).toBe('payment_pending')
    expect(normalizeMembership({ status: 'disabled' }).state).toBe('account_exception')
  })
})
