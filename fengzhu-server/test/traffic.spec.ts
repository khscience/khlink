import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseService } from '../src/database.service'
import { EntitlementService } from '../src/entitlement.service'
import { TrafficService, trafficMonth, trafficResetsAt } from '../src/traffic.service'
import { createTrafficMiddleware } from '../src/traffic.middleware'

describe('free monthly traffic on the official relay', () => {
  let database: DatabaseService; let directory: string; let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'khlink-traffic-'))
    process.env.SQLITE_PATH = join(directory, 'bridge.db'); process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    database = new DatabaseService(); database.onModuleInit()
  })
  afterEach(() => { database.onModuleDestroy(); process.env = saved; if (resolve(dirname(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture path'); rmSync(directory, { recursive: true, force: true }) })

  it('counts months in Beijing time and resets on the first of the month', () => {
    // 2026-10-31 16:30 UTC is already 2026-11-01 00:30 in Beijing.
    const now = Date.UTC(2026, 9, 31, 16, 30)
    expect(trafficMonth(now)).toBe('2026-11')
    expect(trafficMonth(now - 3_600_000)).toBe('2026-10')
    expect(trafficResetsAt(now)).toBe(Date.UTC(2026, 10, 30, 16, 0))
  })

  it('lets an account without a membership write until its free month is used up; members are never limited', () => {
    process.env.KH_LINK_FREE_MONTHLY_BYTES = String(100 * 1024 * 1024)
    const traffic = new TrafficService(database); const entitlement = new EntitlementService(database, traffic)
    const free = database.upsertAccount({ subject: 'free-1', displayName: 'Free', disabled: false })
    let state = entitlement.forAccount(free)
    expect(state).toMatchObject({ source: 'free', canWrite: true, traffic: { usedBytes: 0, limitBytes: 104857600 } })
    traffic.add(free, 60 * 1024 * 1024); traffic.flush(); traffic.add(free, 50 * 1024 * 1024)
    state = entitlement.forAccount(free)
    expect(state.traffic!.usedBytes).toBe(110 * 1024 * 1024)
    expect(state).toMatchObject({ source: 'free', canWrite: false })
    // The refusal says why in the user's language (older phones show it as is).
    expect(entitlement.readOnlyMessage(state)).toContain('本月免费流量已用完')

    const member = database.upsertAccount({ subject: 'member-1', displayName: 'Member', disabled: false })
    database.upsertEntitlement({ accountId: member, product: 'kh_link', state: 'active', plan: 'KH Link', expiresAt: Date.now() + 86_400_000, updatedAt: Date.now() })
    traffic.add(member, 500 * 1024 * 1024)
    expect(entitlement.forAccount(member)).toMatchObject({ source: 'kh_link', canWrite: true, traffic: { usedBytes: 500 * 1024 * 1024 } })
    traffic.onModuleDestroy()
  })

  it('a relay without a free allowance behaves as before and counts nothing over HTTP', () => {
    delete process.env.KH_LINK_FREE_MONTHLY_BYTES
    const traffic = new TrafficService(database); const entitlement = new EntitlementService(database, traffic)
    const account = database.upsertAccount({ subject: 'self-hosted', displayName: 'Self', disabled: false })
    expect(entitlement.forAccount(account)).toMatchObject({ source: 'none', canWrite: false })
    expect(entitlement.forAccount(account).traffic).toBeUndefined()
    let called = false
    createTrafficMiddleware(traffic)({ originalUrl: '/api/v2/history/threads' } as never, {} as never, () => { called = true })
    expect(called).toBe(true)
    traffic.onModuleDestroy()
  })

  it('counts history reads and uploads, request and response, for the signed-in account', () => {
    process.env.KH_LINK_FREE_MONTHLY_BYTES = '1000'
    const traffic = new TrafficService(database)
    const account = database.upsertAccount({ subject: 'reader', displayName: 'Reader', disabled: false })
    const listeners: Record<string, () => void> = {}
    const res = { statusCode: 200, write: () => true, end: () => res, on: (event: string, fn: () => void) => { listeners[event] = fn } }
    const req = { originalUrl: '/api/v2/history/threads?limit=20', headers: { 'content-length': '120' }, accountClaims: { sub: account } }
    createTrafficMiddleware(traffic)(req as never, res as never, () => {})
    ;(res as unknown as { write: (chunk: string) => boolean }).write('x'.repeat(300))
    ;(res as unknown as { end: (chunk: string) => unknown }).end('y'.repeat(80))
    listeners.finish()
    expect(traffic.usage(account).usedBytes).toBe(120 + 300 + 80)
    traffic.onModuleDestroy()
  })
})
