import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { DatabaseService } from '../src/database.service'
import { EntitlementService } from '../src/entitlement.service'
import { PAIRING_TTL_MS, PairingService } from '../src/pairing.service'
import { V2AuthService } from '../src/v2-auth.service'
import { V2SessionController } from '../src/v2-session.controller'

describe('KH Link v2 account boundary', () => {
  let directory: string
  let previousPath: string | undefined
  let previousKey: string | undefined
  let database: DatabaseService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kh-link-v2-'))
    previousPath = process.env.SQLITE_PATH
    previousKey = process.env.TOKEN_SIGNING_KEY
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    database = new DatabaseService()
    database.onModuleInit()
  })

  afterEach(() => {
    database.onModuleDestroy()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    if (previousKey === undefined) delete process.env.TOKEN_SIGNING_KEY
    else process.env.TOKEN_SIGNING_KEY = previousKey
    rmSync(directory, { recursive: true, force: true })
  })

  it('pairs one phone with a one-time code and issues account-scoped tokens', () => {
    const accountId = database.upsertAccount({ subject: 'wp-42', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'desktop-1', name: 'KH-PC', type: 'desktop', publicKey: 'desktop-key' })
    database.upsertEntitlement({ accountId, product: 'khquant', state: 'active', plan: 'khQuant VIP', expiresAt: Date.now() + 86_400_000 })
    const pairing = new PairingService(database)
    const created = pairing.create(accountId, 'desktop-1') as { id: string; secret: string; expiresAt: number }
    expect(created).toHaveProperty('expiresAt')
    expect(created.expiresAt - Date.now()).toBeGreaterThan(PAIRING_TTL_MS - 1_000)
    const phonePublicKey = Buffer.alloc(32, 0xff).toString('base64')

    expect(pairing.claim({ id: created.id, secret: created.secret, deviceId: 'phone-1', deviceName: 'Test Phone', publicKey: phonePublicKey }))
      .toEqual({ status: 'pending', accountId })
    expect(pairing.status(accountId, created.id)).toMatchObject({ status: 'pending', deviceId: 'phone-1' })
    expect(pairing.confirm(accountId, created.id, 'encrypted-account-key')).toEqual({ confirmed: true })
    const consumed = pairing.consume(created.id, created.secret)!
    expect(consumed).toMatchObject({ accountId, androidDeviceId: 'phone-1', keyEnvelope: 'encrypted-account-key' })
    expect(() => pairing.consume(created.id, created.secret)).toThrow('Pairing was already consumed')

    const auth = new V2AuthService(database)
    const session = auth.issue(accountId, 'phone-1', 'android') as { accessToken: string; refreshToken: string }
    expect(auth.verify(session.accessToken)).toMatchObject({ sub: accountId, deviceId: 'phone-1', version: 2 })
    const malformedBody = Buffer.from(JSON.stringify({ version: 2, sub: accountId })).toString('base64url')
    const malformedSignature = createHmac('sha256', Buffer.alloc(32, 7)).update(malformedBody).digest('base64url')
    const malformedToken = `${malformedBody}.${malformedSignature}`
    expect(() => auth.verify(malformedToken)).toThrow('Malformed token')
    const refreshed = auth.refresh(accountId, 'phone-1', session.refreshToken) as { accessToken: string; refreshToken: string }
    expect(refreshed).toHaveProperty('accessToken')
    expect(refreshed.refreshToken).toBe(session.refreshToken)
    expect(auth.refresh(accountId, 'phone-1', session.refreshToken)).toHaveProperty('accessToken')
    expect(new EntitlementService(database).forAccount(accountId)).toMatchObject({ source: 'khquant', canWrite: true })
  })

  it('a device in use keeps its login past 30 days: each refresh slides the expiry', () => {
    const accountId = database.upsertAccount({ subject: 'wp-30', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'connector-1', name: 'KH-PC', type: 'desktop', publicKey: 'k' })
    const auth = new V2AuthService(database)
    const realNow = Date.now
    const day = 86_400_000
    let now = realNow()
    Date.now = () => now
    try {
      const session = auth.issue(accountId, 'connector-1', 'desktop') as { refreshToken: string }
      for (let i = 0; i < 4; i++) {
        now += 20 * day
        expect(auth.refresh(accountId, 'connector-1', session.refreshToken)).toHaveProperty('accessToken')
      }
      expect(database.getAccountDevice(accountId, 'connector-1')!.refreshExpiresAt).toBe(now + 30 * day)
      // Unused for more than 30 days: the login does end.
      now += 31 * day
      expect(() => auth.refresh(accountId, 'connector-1', session.refreshToken)).toThrow('Device revoked or refresh expired')
      // A revoked device is not revived by a refresh.
      const other = auth.issue(accountId, 'connector-1', 'desktop') as { refreshToken: string }
      database.revokeAccountDevice(accountId, 'connector-1')
      expect(() => auth.refresh(accountId, 'connector-1', other.refreshToken)).toThrow('Device revoked or refresh expired')
    } finally { Date.now = realNow }
  })

  it('keeps encrypted history isolated by account', () => {
    const first = database.upsertAccount({ subject: 'wp-1', displayName: 'A', disabled: false })
    const second = database.upsertAccount({ subject: 'wp-2', displayName: 'B', disabled: false })
    database.upsertAccountThread(first, { id: 'same-thread', connectorId: 'pc-a', nonce: 'n-a', ciphertext: 'c-a', archived: false, updatedAt: 1 })
    database.upsertAccountThread(second, { id: 'same-thread', connectorId: 'pc-b', nonce: 'n-b', ciphertext: 'c-b', archived: false, updatedAt: 2 })
    database.upsertAccountItems(first, 'same-thread', [{ id: 'same-item', order: 1, nonce: 'n-a', ciphertext: 'c-a', createdAt: 1 }])
    database.upsertAccountItems(second, 'same-thread', [{ id: 'same-item', order: 1, nonce: 'n-b', ciphertext: 'c-b', createdAt: 2 }])

    expect(database.listAccountThreads(first, null, 30)).toEqual([
      { id: 'same-thread', connectorId: 'pc-a', nonce: 'n-a', ciphertext: 'c-a', archived: 0, updatedAt: 1 },
    ])
    expect(database.listAccountItems(second, 'same-thread', null, 30)).toEqual([
      { id: 'same-item', itemOrder: 1, nonce: 'n-b', ciphertext: 'c-b', createdAt: 2 },
    ])
  })

  it('reads forward history ranges without crossing account boundaries', () => {
    const first = database.upsertAccount({ subject: 'wp-forward-a', displayName: 'A', disabled: false })
    const second = database.upsertAccount({ subject: 'wp-forward-b', displayName: 'B', disabled: false })
    database.upsertAccountThread(first, { id: 'same-thread', connectorId: 'pc-a', nonce: 'n-a', ciphertext: 'c-a', archived: false, updatedAt: 1 })
    database.upsertAccountThread(second, { id: 'same-thread', connectorId: 'pc-b', nonce: 'n-b', ciphertext: 'c-b', archived: false, updatedAt: 1 })
    database.upsertAccountItems(first, 'same-thread', [1, 2, 3, 4].map((order) => ({
      id: `a-${order}`, order, nonce: 'n-a', ciphertext: 'c-a', createdAt: order,
    })))
    database.upsertAccountItems(second, 'same-thread', [{ id: 'b-4', order: 4, nonce: 'n-b', ciphertext: 'c-b', createdAt: 4 }])

    expect(database.listAccountItems(first, 'same-thread', null, 10, 2).map((item: any) => item.itemOrder)).toEqual([3, 4])
    expect(database.listAccountItems(second, 'same-thread', null, 10, 0).map((item: any) => item.id)).toEqual(['b-4'])
  })

  it('lets an authenticated desktop provision one account-scoped connector identity', () => {
    const accountId = database.upsertAccount({ subject: 'wp-connector', displayName: 'KH', disabled: false })
    database.upsertAccountDevice({ accountId, id: 'desktop-1', name: 'KH-PC', type: 'desktop', publicKey: 'desktop-key' })
    const auth = new V2AuthService(database)
    const controller = new V2SessionController({} as never, database, auth, new EntitlementService(database))
    const request = { accountClaims: { sub: accountId, deviceId: 'desktop-1', type: 'desktop', version: 2, exp: Date.now() + 1000 } } as never

    const session = controller.connectorSession(request, { deviceName: 'KH-PC 后台连接器' }) as { accessToken: string; deviceId: string }

    expect(session.deviceId).toBe('desktop-1.connector')
    expect(auth.verify(session.accessToken)).toMatchObject({ sub: accountId, deviceId: 'desktop-1.connector', type: 'connector' })
    expect(database.getAccountDevice(accountId, 'desktop-1.connector')).toMatchObject({ name: 'KH-PC 后台连接器', type: 'connector' })
  })

  it('allows multiple desktop identities and provisions an isolated connector for each', async () => {
    const identity = {
      completeAuthorization: jest.fn(async () => ({
        profile: { subject: 'wp-multi-desktop', displayName: 'KH', disabled: false },
        khQuantMembership: { state: 'active', plan: 'khQuant VIP', expiresAt: Date.now() + 86_400_000 },
      })),
    }
    const auth = new V2AuthService(database)
    const controller = new V2SessionController(identity as never, database, auth, new EntitlementService(database))
    const base = { state: 'state', code: 'code', codeVerifier: 'verifier', publicKey: 'public-key' }

    const first = await controller.complete({ ...base, deviceId: 'desktop-a', deviceName: '办公室电脑' }) as { session: { deviceId: string } }
    const second = await controller.complete({ ...base, deviceId: 'desktop-b', deviceName: '家里电脑' }) as { session: { deviceId: string } }
    const accountId = database.upsertAccount({ subject: 'wp-multi-desktop', displayName: 'KH', disabled: false })
    controller.connectorSession({ accountClaims: { sub: accountId, deviceId: 'desktop-a', type: 'desktop', version: 2, exp: Date.now() + 1000 } } as never, { deviceName: '办公室电脑连接器' })
    controller.connectorSession({ accountClaims: { sub: accountId, deviceId: 'desktop-b', type: 'desktop', version: 2, exp: Date.now() + 1000 } } as never, { deviceName: '家里电脑连接器' })

    expect(first.session.deviceId).toBe('desktop-a')
    expect(second.session.deviceId).toBe('desktop-b')
    expect(database.listAccountDevices(accountId).map((device) => device.id)).toEqual(expect.arrayContaining([
      'desktop-a', 'desktop-b', 'desktop-a.connector', 'desktop-b.connector',
    ]))
  })
})
