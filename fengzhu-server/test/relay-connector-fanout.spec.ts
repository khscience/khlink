import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { DatabaseService } from '../src/database.service'
import { RelayGateway } from '../src/relay.gateway'
import { TrafficService } from '../src/traffic.service'

// Two computers on one account: what one connector sends reaches the phone,
// never the other connector, live or when it catches up on missed events.
describe('connector frames are not forwarded to other connectors', () => {
  let server: Server; let gateway: RelayGateway; let database: DatabaseService; let traffic: TrafficService; let directory: string; let saved: NodeJS.ProcessEnv
  let account: string
  const types: Record<string, string> = { 'pc-a.connector': 'connector', 'pc-b.connector': 'connector', phone: 'android' }

  beforeEach(async () => {
    saved = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'khlink-fanout-'))
    process.env.SQLITE_PATH = join(directory, 'relay.db'); process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64'); process.env.KH_LINK_FREE_MONTHLY_BYTES = '1000000'
    database = new DatabaseService(); database.onModuleInit()
    account = database.upsertAccount({ subject: '501', displayName: 'Fanout', disabled: false })
    for (const [id, type] of Object.entries(types)) database.upsertAccountDevice({ accountId: account, id, name: id, type: type as never })
    traffic = new TrafficService(database)
    server = createServer()
    gateway = new RelayGateway({ verifyAccess: () => { throw new Error('legacy') } } as never,
      { verify: (token: string) => ({ sub: account, deviceId: token, type: types[token], exp: Date.now() + 60_000, version: 2 }) } as never,
      { forAccount: () => ({ canWrite: true, source: 'khquant' }) } as never, database, traffic)
    gateway.attach(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    gateway.onModuleDestroy(); traffic.onModuleDestroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    database.onModuleDestroy(); process.env = saved; rmSync(directory, { recursive: true, force: true })
  })

  async function open(device: string): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
    const address = server.address() as { port: number }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge/v2/ws`, { headers: { Authorization: `Bearer ${device}` } })
    const frames: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject) })
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    return { socket, frames }
  }

  it('delivers a connector frame to the phone only, and a phone command to both computers', async () => {
    const a = await open('pc-a.connector'); const b = await open('pc-b.connector'); const phone = await open('phone')
    const acked = (client: { frames: Array<Record<string, unknown>> }, id: string) => new Promise<void>(resolve => {
      const check = setInterval(() => { if (client.frames.some(f => f.type === 'ack' && f.id === id)) { clearInterval(check); resolve() } }, 5)
    })
    a.socket.send(JSON.stringify({ id: 'status-1', kind: 'command.result', nonce: 'n', ciphertext: 'x'.repeat(100) }))
    await acked(a, 'status-1')
    phone.socket.send(JSON.stringify({ id: 'cmd-1', kind: 'command', nonce: 'n', ciphertext: 'y'.repeat(50) }))
    await acked(phone, 'cmd-1')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(phone.frames.filter(f => !f.type).map(f => f.id)).toEqual(['status-1'])
    expect(b.frames.filter(f => !f.type).map(f => f.id)).toEqual(['cmd-1'])
    expect(a.frames.filter(f => !f.type).map(f => f.id)).toEqual(['cmd-1'])
    // Catching up over HTTP leaves out the other connector's frame as well.
    expect(database.listAccountEvents(account, 'pc-b.connector', 0, 50, true).map(f => f.id)).toEqual(['cmd-1'])
    expect(database.listAccountEvents(account, 'phone', 0, 50).map(f => f.id)).toEqual(['status-1'])
    // Only the phone's copy is counted as delivered.
    traffic.flush()
    const devices = database.deviceTraffic([account], '2000-01-01', '2999-12-31')
    expect(devices.find(d => d.deviceId === 'pc-b.connector')!.downBytes).toBeGreaterThan(0)
    expect(devices.find(d => d.deviceId === 'phone')!.downBytes).toBeGreaterThan(100)
    const bDown = devices.find(d => d.deviceId === 'pc-b.connector')!.downBytes
    expect(bDown).toBeLessThan(devices.find(d => d.deviceId === 'phone')!.downBytes)
    for (const client of [a, b, phone]) client.socket.close()
  })
})
