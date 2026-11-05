import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHmac } from 'node:crypto'
import type { ExecutionContext } from '@nestjs/common'
import { DatabaseService } from '../src/database.service'
import { AdminGuard, adminSignature } from '../src/admin.guard'
import { BillingController, billingPayload, type BillingInput } from '../src/billing.controller'
import { V2AuthService } from '../src/v2-auth.service'
import { EntitlementService } from '../src/entitlement.service'
import { AdminController } from '../src/admin.controller'
import { downloadEvent } from '../src/download-metrics.service'
import { PairingService } from '../src/pairing.service'

describe('KH Link website administration', () => {
  let database: DatabaseService; let directory: string; let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'khlink-admin-'))
    process.env.SQLITE_PATH = join(directory, 'bridge.db'); process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64')
    process.env.KH_LINK_ADMIN_SECRET = 'administration-test-secret-32-characters'; process.env.KH_LINK_BILLING_SITE_SECRET = 'billing-site-test-secret-32-characters'
    delete process.env.KH_LINK_ADMIN_SECRET_FILE; delete process.env.KH_LINK_BILLING_SITE_SECRET_FILE
    database = new DatabaseService(); database.onModuleInit()
  })
  afterEach(() => { database.onModuleDestroy(); process.env = saved; if (resolve(dirname(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture path'); rmSync(directory, { recursive: true, force: true }) })
  function request(body: object, timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'test-nonce-that-is-long-enough-1234') {
    const path = '/api/v2/admin/query'; return { method: 'POST', originalUrl: path, body, headers: { 'x-khlink-timestamp': timestamp, 'x-khlink-nonce': nonce,
      'x-khlink-admin-signature': adminSignature(process.env.KH_LINK_ADMIN_SECRET!, 'POST', path, timestamp, nonce, body) } }
  }
  function context(req: object) { return { switchToHttp: () => ({ getRequest: () => req }) } as ExecutionContext }
  function send(body: BillingInput) { return new BillingController(database).webhook(createHmac('sha256', process.env.KH_LINK_BILLING_SITE_SECRET!).update(billingPayload(body)).digest('hex'), body) }
  it('requires signed method/path/body, freshness, and a durable one-time nonce', () => {
    const guard = new AdminGuard(database); const req = request({ subject: '1' })
    expect(guard.canActivate(context(req))).toBe(true)
    expect(() => guard.canActivate(context(req))).toThrow(/replayed/)
    expect(() => guard.canActivate(context({ ...request({ subject: '1' }, undefined, 'another-valid-long-nonce-1234'), body: { subject: '2' } }))).toThrow()
    expect(() => guard.canActivate(context(request({}, String(Math.floor(Date.now() / 1000) - 301))))).toThrow()
    expect(() => guard.canActivate(context({ ...request({}), originalUrl: '/api/v2/admin/action' }))).toThrow()
    expect(() => guard.canActivate(context({ ...request({}), method: 'GET' }))).toThrow()
  })
  it('stores a subject grant before the first App login and rejects stale retries/conflicting events', () => {
    const body: BillingInput = { subject: '77', state: 'active', plan: 'KH Link', expiresAt: Date.now() + 86400000, eventId: 'grant-77', timestamp: Date.now(), occurredAt: Date.now() - 1000 }
    expect(send(body)).toEqual({ accepted: true, changed: true, pending: true })
    expect(send({ ...body, timestamp: Date.now() })).toEqual({ accepted: true, changed: false, pending: true })
    const account = database.upsertAccount({ subject: '77', displayName: 'Fixture', disabled: false })
    expect(new EntitlementService(database).forAccount(account).source).toBe('kh_link')
    send({ ...body, state: 'expired', eventId: 'revoke-77', occurredAt: body.occurredAt! + 1, timestamp: Date.now() })
    expect(new EntitlementService(database).forAccount(account).canWrite).toBe(false)
    send({ ...body, eventId: 'older-77', occurredAt: body.occurredAt! - 1, timestamp: Date.now() })
    expect(new EntitlementService(database).forAccount(account).canWrite).toBe(false)
    expect(() => send({ ...body, state: 'expired' })).toThrow(/identity conflict/)
    database.upsertAccount({ subject: '77', displayName: 'Fixture', disabled: false })
    expect(new EntitlementService(database).forAccount(account).canWrite).toBe(false)
  })
  it('ban survives OAuth upserts, blocks login/refresh/access and QR claim; unban retains device ownership', () => {
    const id = database.upsertAccount({ subject: '88', displayName: 'Fixture', disabled: false })
    database.upsertAccountDevice({ accountId: id, id: 'phone', name: 'Phone', type: 'android', publicKey: 'not-returned', keyEnvelope: 'not-returned' })
    const auth = new V2AuthService(database); const session = auth.issue(id, 'phone', 'android') as { accessToken: string; refreshToken: string }
    const pairing = new PairingService(database); const qr = pairing.create(id, 'phone') as { id: string; secret: string }
    const relay = { disconnectAccount: jest.fn(), accountDeviceOnline: () => false, accountOnlineCount: () => 0, onlineConnectorCount: () => 0 }
    const controller = new AdminController(database, relay as never, new EntitlementService(database))
    const input = { subject: '88', operation: 'ban', actorSubject: '1', reason: 'Fixture ban', eventId: 'fixture-ban-event-88', confirmed: true }
    controller.action(input); expect(relay.disconnectAccount).toHaveBeenCalledWith(id)
    database.upsertAccount({ subject: '88', displayName: 'Fixture', disabled: false })
    expect(() => auth.verify(session.accessToken)).toThrow(); expect(() => auth.refresh(id, 'phone', session.refreshToken)).toThrow(); expect(() => auth.issue(id, 'phone', 'android')).toThrow()
    expect(() => pairing.claim({ id: qr.id, secret: qr.secret, deviceId: 'another-phone', deviceName: 'Phone', publicKey: Buffer.alloc(32).toString('base64') })).toThrow(/revoked/)
    controller.action({ ...input, operation: 'unban', eventId: 'fixture-unban-event-88' }); expect(auth.verify(session.accessToken).sub).toBe(id)
    const data = controller.query({ subject: '88' }) as { devices: object[] }
    expect(JSON.stringify(data.devices)).not.toMatch(/publicKey|keyEnvelope|refreshHash|not-returned/)
    expect(() => controller.action({ ...input, operation: 'revoke-device', deviceId: 'foreign', eventId: 'fixture-revoke-event-88' })).toThrow(/owned/)
    controller.action({ ...input, operation: 'revoke-device', deviceId: 'phone', eventId: 'fixture-revoke-device-88' }); expect(() => auth.verify(session.accessToken)).toThrow()
  })
  it('counts only the published package download start, excluding HEAD, verification, later ranges and missing files', () => {
    const packages = [{ file: 'app.apk', version: '0.1.202', platform: 'android' }]
    const row = { id:'request-123456',method:'GET',uri:'/fengzhu-bridge/downloads/app.apk',status:'200',bytes:'2000',range:'',contentRange:'',verify:'',agent:'user',at:new Date().toISOString(),ip:'127.0.0.1',referer:'https://khsci.com/khlink/' }
    const event = downloadEvent(row, packages)!; database.recordAdminDownload(event); database.recordAdminDownload(event)
    expect((database.adminDownloadStats() as { summary: { total: number } }).summary.total).toBe(1)
    for (const change of [{ method:'HEAD' },{ status:'404' },{ bytes:'0' },{ verify:'1' },{ range:'bytes=99-' },{ uri:'/old.apk' },{ agent:'KH-Link-release-verifier' }]) expect(downloadEvent({ ...row, ...change }, packages)).toBeNull()
    expect(downloadEvent({ ...row,status:'206',range:'bytes=0-',contentRange:'bytes 0-100/2000' }, packages)).not.toBeNull()
    expect(downloadEvent({ ...row,status:'206',range:'',contentRange:'bytes 100-200/2000' }, packages)).toBeNull()
    expect(downloadEvent({ ...row,referer:'',source:'website' }, packages)?.source).toBe('website')
    database.recordAdminDownload({ ...event, requestId:'expired-fixture', at:Date.now()-91*86400000 })
    database.pruneDownloadDetails()
    expect((database.adminDownloadStats() as { total: number }).total).toBe(1)
  })
})
