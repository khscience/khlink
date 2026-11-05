import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseService } from '../src/database.service'
import { EntitlementService } from '../src/entitlement.service'
import { V2AuthService } from '../src/v2-auth.service'
import { V2SessionController } from '../src/v2-session.controller'
import { PairingService } from '../src/pairing.service'
import type { V2Request } from '../src/v2-auth.guard'

// Fake khQuant identity: completeAuthorization returns a fixed profile/membership.
function fakeIdentity(profile: { subject: string; disabled?: boolean }, membershipState: string) {
  return {
    completeAuthorization: async () => ({
      profile: { subject: profile.subject, displayName: 'KH', disabled: Boolean(profile.disabled) },
      khQuantMembership: { state: membershipState, plan: 'khQuant VIP', expiresAt: Date.now() + 86_400_000 },
    }),
  } as any
}

function reqFor(claims: { sub: string; deviceId: string; type: string }): V2Request {
  return { accountClaims: { ...claims, exp: Date.now() + 60_000, version: 2 } } as any
}

describe('KH Link phone login + connector key handoff', () => {
  let directory: string, prevPath: string | undefined, prevKey: string | undefined, prevAdmins: string | undefined
  let database: DatabaseService, auth: V2AuthService, entitlement: EntitlementService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kh-link-phone-'))
    prevPath = process.env.SQLITE_PATH; prevKey = process.env.TOKEN_SIGNING_KEY; prevAdmins = process.env.KH_LINK_ADMIN_SUBJECTS
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    delete process.env.KH_LINK_ADMIN_SUBJECTS
    database = new DatabaseService(); database.onModuleInit()
    auth = new V2AuthService(database); entitlement = new EntitlementService(database)
  })
  afterEach(() => {
    database.onModuleDestroy()
    for (const [k, v] of [['SQLITE_PATH', prevPath], ['TOKEN_SIGNING_KEY', prevKey], ['KH_LINK_ADMIN_SUBJECTS', prevAdmins]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    rmSync(directory, { recursive: true, force: true })
  })

  const phoneKey = Buffer.alloc(32, 0xab).toString('base64')
  const sealed = JSON.stringify({ version: 3, algorithm: 'X25519-XChaCha20-Poly1305',
    senderPublicKey: Buffer.alloc(32, 1).toString('base64'), nonce: Buffer.alloc(24, 2).toString('base64'),
    ciphertext: Buffer.alloc(48, 3).toString('base64') })
  const paired = JSON.stringify({ version: 2, desktopPublicKey: phoneKey, nonce: 'pairing-nonce', ciphertext: 'pairing-key' })
  const body = (over: object = {}) => ({ state: 's', code: 'c', codeVerifier: 'v', deviceId: 'phone-1', deviceName: 'Test Phone', publicKey: phoneKey, deviceType: 'android' as const, ...over })

  it('admits an active member phone, registers it pending, and the connector delivers the key', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-1' }, 'active'), database, auth, entitlement)
    const result = await controller.complete(body()) as any
    expect(result.keyPending).toBe(true)
    expect(result.session).toMatchObject({ deviceId: 'phone-1' })
    const accountId = result.session.accountId

    // Phone polls: still pending (connector hasn't wrapped yet).
    expect(controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toEqual({ pending: true })

    // Connector sees the pending phone.
    database.upsertAccountDevice({ accountId, id: 'c1', name: 'conn', type: 'connector' })
    const pending = controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })) as any
    expect(pending.devices).toEqual([{ deviceId: 'phone-1', name: 'Test Phone', publicKey: phoneKey, type: 'android' }])

    // Connector delivers the wrapped key.
    expect(controller.provideKey(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' }), { deviceId: 'phone-1', keyEnvelope: sealed })).toEqual({ delivered: true })
    expect(controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toEqual({ keyEnvelope: sealed })
    // Once delivered it is no longer pending for the connector.
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })) as any).devices).toEqual([])
  })

  it('repairs an already stored QR envelope when the phone logs in with its account', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-legacy' }, 'active'), database, auth, entitlement)
    const accountId = database.upsertAccount({ subject: 'wp-legacy', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'phone-1', name: 'Test Phone', type: 'android', publicKey: phoneKey, keyEnvelope: paired })
    await controller.complete(body())
    const phone = reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' })
    const connector = reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })
    expect(controller.keyEnvelope(phone)).toEqual({ pending: true })
    expect((controller.pendingKeys(connector) as any).devices).toEqual([{ deviceId: 'phone-1', name: 'Test Phone', publicKey: phoneKey, type: 'android' }])
    controller.provideKey(connector, { deviceId: 'phone-1', keyEnvelope: sealed })
    expect(controller.keyEnvelope(phone)).toEqual({ keyEnvelope: sealed })
    expect((controller.pendingKeys(connector) as any).devices).toEqual([])
  })

  it('returns the QR envelope once without storing it as an account-login envelope', () => {
    const accountId = database.upsertAccount({ subject: 'wp-pairing', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'desktop-1', name: 'PC', type: 'desktop' })
    const pairing = new PairingService(database)
    const created = pairing.create(accountId, 'desktop-1') as { id: string; secret: string }
    pairing.claim({ ...created, deviceId: 'phone-1', deviceName: 'Test Phone', publicKey: phoneKey })
    pairing.confirm(accountId, created.id, paired)
    expect(pairing.consume(created.id, created.secret)).toMatchObject({ keyEnvelope: paired })
    expect(database.getAccountDevice(accountId, 'phone-1')?.keyEnvelope).toBeNull()
    expect(() => pairing.consume(created.id, created.secret)).toThrow('already consumed')
  })

  it('keeps a valid v3 envelope when the same phone logs in again', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-repeat' }, 'active'), database, auth, entitlement)
    const accountId = database.upsertAccount({ subject: 'wp-repeat', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'phone-1', name: 'Test Phone', type: 'android', publicKey: phoneKey, keyEnvelope: sealed })
    await controller.complete(body())
    expect(controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toEqual({ keyEnvelope: sealed })
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })) as any).devices).toEqual([])
  })

  it('requests a new envelope after the phone public key changes', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-rekey' }, 'active'), database, auth, entitlement)
    const accountId = database.upsertAccount({ subject: 'wp-rekey', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'phone-1', name: 'Test Phone', type: 'android', publicKey: phoneKey, keyEnvelope: sealed })
    const newKey = Buffer.alloc(32, 0xcd).toString('base64')
    await controller.complete(body({ publicKey: newKey }))
    expect(controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toEqual({ pending: true })
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })) as any).devices[0].publicKey).toBe(newKey)
  })

  it.each([paired, 'not-json', JSON.stringify({ version: 3 }), sealed.replace('X25519-XChaCha20-Poly1305', 'unknown')])(
    'does not mark a phone provisioned with an incompatible or malformed envelope', async (keyEnvelope) => {
      const controller = new V2SessionController(fakeIdentity({ subject: 'wp-invalid' }, 'active'), database, auth, entitlement)
      const accountId = ((await controller.complete(body())) as any).session.accountId
      const connector = reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' })
      expect(() => controller.provideKey(connector, { deviceId: 'phone-1', keyEnvelope })).toThrow('device-key v3')
      expect(controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toEqual({ pending: true })
    },
  )

  it('rejects a non-member phone when no admin allowlist is set', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-2' }, 'expired'), database, auth, entitlement)
    await expect(controller.complete(body())).rejects.toThrow('active khLink membership')
  })

  it('admin allowlist admits a listed non-member and rejects everyone else', async () => {
    process.env.KH_LINK_ADMIN_SUBJECTS = 'wp-admin , wp-x'
    const admin = new V2SessionController(fakeIdentity({ subject: 'wp-admin' }, 'expired'), database, auth, entitlement)
    expect(((await admin.complete(body())) as any).keyPending).toBe(true)
    const outsider = new V2SessionController(fakeIdentity({ subject: 'wp-outsider' }, 'active'), database, auth, entitlement)
    await expect(outsider.complete(body())).rejects.toThrow('not allowed')
  })

  it('rejects a disabled khQuant account', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-3', disabled: true }, 'active'), database, auth, entitlement)
    await expect(controller.complete(body())).rejects.toThrow('disabled')
  })

  it('does not let a phone token fetch another device envelope or act as connector', async () => {
    const controller = new V2SessionController(fakeIdentity({ subject: 'wp-4' }, 'active'), database, auth, entitlement)
    const accountId = ((await controller.complete(body())) as any).session.accountId
    expect(() => controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'phone-1', type: 'android' }))).toThrow('connector')
    expect(() => controller.keyEnvelope(reqFor({ sub: accountId, deviceId: 'c1', type: 'connector' }))).toThrow('phone')
  })
})
