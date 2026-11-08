import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseService } from '../src/database.service'
import { EntitlementService } from '../src/entitlement.service'
import { V2AuthService } from '../src/v2-auth.service'
import { KEY_PENDING, V2SessionController } from '../src/v2-session.controller'
import type { V2Request } from '../src/v2-auth.guard'

function fakeIdentity() {
  return {
    completeAuthorization: async () => ({
      profile: { subject: 'wp-multi', displayName: 'KH', disabled: false },
      khQuantMembership: { state: 'active', plan: 'khQuant VIP', expiresAt: Date.now() + 86_400_000 },
    }),
  } as any
}
const reqFor = (claims: { sub: string; deviceId: string; type: string }): V2Request => ({ accountClaims: { ...claims, exp: Date.now() + 60_000, version: 2 } } as any)

describe('one account, several computers', () => {
  let directory: string, prevPath: string | undefined, prevKey: string | undefined
  let database: DatabaseService, controller: V2SessionController
  const keyA = Buffer.alloc(32, 0xa1).toString('base64')
  const keyB = Buffer.alloc(32, 0xb2).toString('base64')
  const sealed = JSON.stringify({ version: 3, algorithm: 'X25519-XChaCha20-Poly1305',
    senderPublicKey: Buffer.alloc(32, 1).toString('base64'), nonce: Buffer.alloc(24, 2).toString('base64'),
    ciphertext: Buffer.alloc(48, 3).toString('base64') })
  const desktop = (deviceId: string, publicKey: string) => ({ state: 's', code: 'c', codeVerifier: 'v', deviceId, deviceName: deviceId, publicKey })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kh-link-multi-'))
    prevPath = process.env.SQLITE_PATH; prevKey = process.env.TOKEN_SIGNING_KEY
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    database = new DatabaseService(); database.onModuleInit()
    const auth = new V2AuthService(database)
    controller = new V2SessionController(fakeIdentity(), database, auth, new EntitlementService(database))
  })
  afterEach(() => {
    database.onModuleDestroy()
    if (prevPath === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = prevPath
    if (prevKey === undefined) delete process.env.TOKEN_SIGNING_KEY; else process.env.TOKEN_SIGNING_KEY = prevKey
    rmSync(directory, { recursive: true, force: true })
  })

  it('the first computer keeps its own key; a second one waits for it and receives it', async () => {
    const first = await controller.complete(desktop('pc-a', keyA)) as any
    expect(first.keyPending).toBeUndefined()
    const accountId = first.session.accountId
    database.upsertAccountDevice({ accountId, id: 'pc-a.connector', name: 'A', type: 'connector' })

    // Logging in again on the same computer does not ask for a key.
    expect((await controller.complete(desktop('pc-a', keyA)) as any).keyPending).toBeUndefined()

    const second = await controller.complete(desktop('pc-b', keyB)) as any
    expect(second.keyPending).toBe(true)
    expect(database.getAccountDevice(accountId, 'pc-b')?.keyEnvelope).toBe(KEY_PENDING)
    const b = reqFor({ sub: accountId, deviceId: 'pc-b', type: 'desktop' })
    expect(controller.keyEnvelope(b)).toEqual({ pending: true, holders: ['pc-a'] })

    // Computer A's connector sees B waiting; B never lists itself.
    const fromA = controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'pc-a.connector', type: 'connector' })) as any
    expect(fromA.devices).toEqual([{ deviceId: 'pc-b', name: 'pc-b', publicKey: keyB, type: 'desktop' }])
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'pc-b.connector', type: 'connector' })) as any).devices).toEqual([])

    expect(controller.provideKey(reqFor({ sub: accountId, deviceId: 'pc-a.connector', type: 'connector' }), { deviceId: 'pc-b', keyEnvelope: sealed })).toEqual({ delivered: true })
    expect(controller.keyEnvelope(b)).toEqual({ keyEnvelope: sealed })
    expect(database.getAccountDevice(accountId, 'pc-b')?.type).toBe('desktop')
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'pc-a.connector', type: 'connector' })) as any).devices).toEqual([])

    // B logging in again with the key it holds is not pending any more.
    expect((await controller.complete(desktop('pc-b', keyB)) as any).keyPending).toBeUndefined()
  })

  it('a computer that already holds its key is never overwritten by another connector', async () => {
    const first = await controller.complete(desktop('pc-a', keyA)) as any
    const accountId = first.session.accountId
    database.upsertAccountDevice({ accountId, id: 'pc-x.connector', name: 'X', type: 'connector' })
    expect(() => controller.provideKey(reqFor({ sub: accountId, deviceId: 'pc-x.connector', type: 'connector' }), { deviceId: 'pc-a', keyEnvelope: sealed }))
      .toThrow('Target phone is not registered')
  })

  it('a revoked computer does not keep the account in multi-computer mode', async () => {
    const first = await controller.complete(desktop('pc-a', keyA)) as any
    const accountId = first.session.accountId
    database.revokeAccountDevice(accountId, 'pc-a')
    const next = await controller.complete(desktop('pc-b', keyB)) as any
    expect(next.keyPending).toBeUndefined()
  })

  it('a new computer that takes over after the old ones are gone re-keys the phones', async () => {
    const first = await controller.complete(desktop('pc-a', keyA)) as any
    const accountId = first.session.accountId
    database.upsertAccountDevice({ accountId, id: 'pc-a.connector', name: 'A', type: 'connector' })
    database.upsertAccountDevice({ accountId, id: 'phone-1', name: 'Phone', type: 'android', publicKey: keyB, keyEnvelope: sealed })

    // The same computer logging in again leaves the phone's key alone.
    await controller.complete(desktop('pc-a', keyA))
    expect(database.getAccountDevice(accountId, 'phone-1')?.keyEnvelope).toBe(sealed)

    database.revokeAccountDevice(accountId, 'pc-a')
    database.revokeAccountDevice(accountId, 'pc-a.connector')
    const next = await controller.complete(desktop('pc-c', keyA)) as any
    expect(next.keyPending).toBeUndefined()
    expect(database.getAccountDevice(accountId, 'phone-1')?.keyEnvelope).toBeNull()
    expect((controller.pendingKeys(reqFor({ sub: accountId, deviceId: 'pc-c.connector', type: 'connector' })) as any).devices)
      .toEqual([{ deviceId: 'phone-1', name: 'Phone', publicKey: keyB, type: 'android' }])
  })

  it('a computer waiting for a key takes over once the computer it waited for is unbound', async () => {
    const first = await controller.complete(desktop('pc-a', keyA)) as any
    const accountId = first.session.accountId
    database.upsertAccountDevice({ accountId, id: 'pc-a.connector', name: 'A', type: 'connector' })
    database.upsertAccountDevice({ accountId, id: 'phone-1', name: 'Phone', type: 'android', publicKey: keyB, keyEnvelope: sealed })
    expect((await controller.complete(desktop('pc-b', keyB)) as any).keyPending).toBe(true)
    const b = reqFor({ sub: accountId, deviceId: 'pc-b', type: 'desktop' })

    database.revokeAccountDevice(accountId, 'pc-a')
    database.revokeAccountDevice(accountId, 'pc-a.connector')
    expect(controller.keyEnvelope(b)).toEqual({ pending: false, noKeyHolder: true })
    expect(database.getAccountDevice(accountId, 'pc-b')?.keyEnvelope).toBeNull()
    expect(database.getAccountDevice(accountId, 'phone-1')?.keyEnvelope).toBeNull()
    // Logging in again later does not ask for a key any more.
    expect((await controller.complete(desktop('pc-b', keyB)) as any).keyPending).toBeUndefined()
  })
})
