import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { RelayGateway } from '../src/relay.gateway'

function connect(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    socket.once('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      socket.close()
      resolve(message)
    })
    socket.once('error', reject)
  })
}

describe('RelayGateway websocket routing', () => {
  let server: Server
  let gateway: RelayGateway

  beforeEach(async () => {
    server = createServer()
    gateway = new RelayGateway(
      { verifyAccess: () => ({ deviceId: 'legacy-device', type: 'connector' }) } as never,
      { verify: () => ({ sub: 'account-1', deviceId: 'v2-device', type: 'connector', exp: Date.now() + 60_000, version: 2 }) } as never,
      { forAccount: () => ({ canWrite: true, source: 'khquant' }) } as never,
      { latestEventSequence: () => 11, latestAccountEventSequence: () => 22, touchAccountDevice: jest.fn() } as never,
    )
    gateway.attach(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    gateway.onModuleDestroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('accepts legacy and account-scoped websocket paths on the same server', async () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a TCP port')

    const [legacy, account] = await Promise.all([
      connect(address.port, '/bridge/ws'),
      connect(address.port, '/bridge/v2/ws'),
    ])

    expect(legacy).toMatchObject({ type: 'ready', deviceId: 'legacy-device', protocolVersion: 1, latestSequence: 11 })
    expect(account).toMatchObject({ type: 'ready', accountId: 'account-1', deviceId: 'v2-device', protocolVersion: 2, latestSequence: 22 })
  })

  it('immediately closes only the revoked account device connection', async () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a TCP port')
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge/v2/ws`, { headers: { Authorization: 'Bearer test-token' } })
    await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject) })
    expect(gateway.accountDeviceOnline('account-1', 'v2-device')).toBe(true)
    gateway.disconnectAccount('other-account')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    gateway.disconnectAccount('account-1', 'v2-device')
    expect(await closed).toBe(4401)
    expect(gateway.accountDeviceOnline('account-1', 'v2-device')).toBe(false)
  })
})
