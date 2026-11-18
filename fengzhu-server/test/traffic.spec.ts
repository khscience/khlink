import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseService } from '../src/database.service'
import { EntitlementService } from '../src/entitlement.service'
import { TrafficService, trafficDay, trafficMonth, trafficResetsAt } from '../src/traffic.service'
import { readFileSync, existsSync } from 'node:fs'
import { createTrafficMiddleware, trafficCategory } from '../src/traffic.middleware'

describe('free monthly traffic on the official relay', () => {
  let database: DatabaseService; let directory: string; let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'khlink-traffic-'))
    process.env.SQLITE_PATH = join(directory, 'bridge.db'); process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    database = new DatabaseService(); database.onModuleInit()
  })
  afterEach(() => { database.onModuleDestroy(); process.env = saved; if (resolve(dirname(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture path'); rmSync(directory, { recursive: true, force: true }) })

  it('counts each Beijing day and writes a relay-wide summary without account identities', () => {
    process.env.KH_LINK_FREE_MONTHLY_BYTES = '5368709120'
    process.env.KH_LINK_TRAFFIC_SUMMARY_FILE = join(directory, 'stats', 'traffic-daily.json')
    expect(trafficDay(Date.UTC(2026, 10, 12, 16, 30))).toBe('2026-11-13')
    const traffic = new TrafficService(database)
    const one = database.upsertAccount({ subject: 'daily-1', displayName: 'One', disabled: false })
    const two = database.upsertAccount({ subject: 'daily-2', displayName: 'Two', disabled: false })
    const now = Date.now(); const yesterday = now - 86_400_000
    traffic.add(one, 100, yesterday); traffic.add(one, 300, now); traffic.add(two, 200, now)
    const summary = traffic.summary(31, now)
    expect(summary.days.slice(-2)).toEqual([{ day: trafficDay(yesterday), bytes: 100, accounts: 1 }, { day: trafficDay(now), bytes: 500, accounts: 2 }])
    expect(summary).toMatchObject({ timezone: 'Asia/Shanghai', freeMonthlyBytes: 5368709120 })
    // The month figure still counts every byte, and usage sees counts not yet written.
    traffic.add(one, 50, now)
    expect(traffic.usage(one, now).usedBytes).toBe(trafficMonth(yesterday) === trafficMonth(now) ? 450 : 350)
    traffic.writeSummary(now)
    const file = process.env.KH_LINK_TRAFFIC_SUMMARY_FILE!
    expect(existsSync(file)).toBe(true); expect(existsSync(`${file}.tmp`)).toBe(false)
    const written = readFileSync(file, 'utf8')
    expect(JSON.parse(written).days.at(-1)).toEqual({ day: trafficDay(now), bytes: 550, accounts: 2 })
    expect(written).not.toMatch(/daily-1|daily-2|One|Two|account_id/)
    traffic.onModuleDestroy()
  })

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
    const req = { originalUrl: '/api/v2/history/threads?limit=20', headers: { 'content-length': '120' }, accountClaims: { sub: account, deviceId: 'phone-1' } }
    createTrafficMiddleware(traffic)(req as never, res as never, () => {})
    ;(res as unknown as { write: (chunk: string) => boolean }).write('x'.repeat(300))
    ;(res as unknown as { end: (chunk: string) => unknown }).end('y'.repeat(80))
    listeners.finish()
    expect(traffic.usage(account).usedBytes).toBe(120 + 300 + 80)
    traffic.flush()
    const today = trafficDay()
    expect(database.deviceTraffic([account], today, today)).toEqual([expect.objectContaining({ deviceId: 'phone-1', upBytes: 120, downBytes: 380, days: [{ day: today, upBytes: 120, downBytes: 380 }] })])
    traffic.onModuleDestroy()
  })

  it('splits traffic by device and day, adding to what was already written', () => {
    const traffic = new TrafficService(database)
    const account = database.upsertAccount({ subject: 'split', displayName: 'Split', disabled: false })
    database.upsertAccountDevice({ accountId: account, id: 'pc.connector', name: 'PC 后台连接器', type: 'connector' as never })
    const now = Date.UTC(2026, 10, 14, 4); const yesterday = now - 86_400_000
    traffic.addDevice(account, 'pc.connector', 1000, 0, yesterday)
    traffic.addDevice(account, 'pc.connector', 500, 20, now); traffic.addDevice(account, 'phone', 0, 700, now)
    traffic.flush(); traffic.addDevice(account, 'pc.connector', 5, 0, now); traffic.addDevice(account, 'phone', 0, 0, now); traffic.flush()
    expect(database.deviceTraffic([account], '2026-11-01', '2026-11-30')).toEqual([
      { accountId: account, deviceId: 'pc.connector', name: 'PC 后台连接器', type: 'connector', revoked: false, upBytes: 1505, downBytes: 20,
        days: [{ day: '2026-11-13', upBytes: 1000, downBytes: 0 }, { day: '2026-11-14', upBytes: 505, downBytes: 20 }] },
      { accountId: account, deviceId: 'phone', name: null, type: null, revoked: false, upBytes: 0, downBytes: 700, days: [{ day: '2026-11-14', upBytes: 0, downBytes: 700 }] },
    ])
    expect(database.deviceTraffic([], '2026-11-01', '2026-11-30')).toEqual([])
    traffic.onModuleDestroy()
  })
  it('names what traffic was for and splits large history rows (images) apart', () => {
    expect(trafficCategory('PUT', '/api/v2/history/threads')).toBe('history.threads.upload')
    expect(trafficCategory('GET', '/api/v2/history/threads?since=5&limit=100')).toBe('history.threads.read.changes')
    expect(trafficCategory('PUT', '/api/v2/history/threads/local_abc/items')).toBe('history.items.upload')
    expect(trafficCategory('GET', '/api/v2/history/threads/01a1cde1-db40-7c62-9ca2-2b1c03db28ac/items?limit=30')).toBe('history.items.read')
    expect(trafficCategory('GET', '/api/v2/history/threads/x/items?changedSince=9&limit=100')).toBe('history.items.read.changes')
    expect(trafficCategory('GET', '/api/v2/events?after=1')).toBe('events.read')
    expect(trafficCategory(undefined, '/api/v2/history/threads')).toBe('history.threads.read')

    process.env.KH_LINK_FREE_MONTHLY_BYTES = '1000'
    const traffic = new TrafficService(database)
    const account = database.upsertAccount({ subject: 'cat', displayName: 'Cat', disabled: false })
    const run = (method: string, url: string, body: unknown, received: number, sent: number, largeDown = 0) => {
      const listeners: Record<string, () => void> = {}
      const res = { statusCode: 200, locals: {} as Record<string, unknown>, write: () => true, end: () => res, on: (event: string, fn: () => void) => { listeners[event] = fn } }
      const req = { method, originalUrl: url, body, headers: { 'content-length': String(received) }, accountClaims: { sub: account, deviceId: 'pc' } }
      createTrafficMiddleware(traffic)(req as never, res as never, () => {})
      if (largeDown) res.locals.largeHistoryBytes = largeDown
      ;(res as unknown as { end: (chunk: string) => unknown }).end('y'.repeat(sent))
      listeners.finish()
    }
    const big = 'b'.repeat(150 * 1024)
    run('PUT', '/api/v2/history/threads/t1/items', { items: [{ ciphertext: big }, { ciphertext: 'small' }] }, big.length + 400, 20)
    run('GET', '/api/v2/history/threads/t1/items?limit=30', undefined, 0, 200 * 1024, 120 * 1024)
    traffic.addCategory(account, 'ws.command.result', 300, 600)
    traffic.flush()
    const day = trafficDay()
    const rows = database.categoryTraffic([account], day, day)
    const by = (category: string) => rows.find(row => row.category === category)
    expect(by('history.items.upload.large')).toMatchObject({ upBytes: big.length, downBytes: 0, requests: 0 })
    expect(by('history.items.upload')).toMatchObject({ upBytes: 400, downBytes: 20, requests: 1 })
    expect(by('history.items.read.large')).toMatchObject({ upBytes: 0, downBytes: 120 * 1024 })
    expect(by('history.items.read')).toMatchObject({ downBytes: 80 * 1024, requests: 1 })
    expect(by('ws.command.result')).toMatchObject({ upBytes: 300, downBytes: 600, requests: 1 })
    expect(rows[0].category).toBe('history.items.upload.large')
    traffic.onModuleDestroy()
  })
})
