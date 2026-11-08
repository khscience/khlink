import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AuthService } from './auth.service'
import { DatabaseService } from './database.service'
import { EntitlementService } from './entitlement.service'
import { TrafficService } from './traffic.service'
import type { AccessClaims, AccountAccessClaims, EncryptedFrame } from './types'

// Small frames the connector sends on its own every few seconds. Counting
// them would use up a free month without the user doing anything.
const CONTROL_FRAMES = new Set(['connector.presence', 'thread.status.snapshot', 'thread.status', 'connector.offline', 'accounts.state', 'codex.usage', 'claude.usage', 'dsh.usage'])
import { V2AuthService } from './v2-auth.service'

type AuthSocket = WebSocket & { claims?: AccessClaims }
type AccountSocket = WebSocket & { accountClaims?: AccountAccessClaims }

@Injectable()
export class RelayGateway implements OnModuleDestroy {
  private wss?: WebSocketServer
  private accountWss?: WebSocketServer
  private server?: HttpServer
  private upgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  private readonly sockets = new Map<string, Set<AuthSocket>>()
  private readonly accountSockets = new Map<string, Map<string, Set<AccountSocket>>>()
  constructor(private readonly auth: AuthService, private readonly v2Auth: V2AuthService,
    private readonly entitlement: EntitlementService, private readonly database: DatabaseService,
    @Optional() private readonly traffic?: TrafficService) {}

  attach(server: HttpServer): void {
    if (this.wss) return
    this.server = server
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
    this.wss.on('connection', (socket: AuthSocket, request) => {
      try {
        const header = request.headers.authorization || ''
        if (!header.startsWith('Bearer ')) throw new Error('missing bearer')
        socket.claims = this.auth.verifyAccess(header.slice(7))
      } catch {
        socket.close(4401, 'unauthorized')
        return
      }
      const id = socket.claims.deviceId
      const set = this.sockets.get(id) || new Set<AuthSocket>()
      set.add(socket); this.sockets.set(id, set)
      socket.on('message', (raw) => this.handle(socket, raw.toString()))
      socket.on('close', () => { set.delete(socket); if (!set.size) this.sockets.delete(id) })
      socket.send(JSON.stringify({ type: 'ready', deviceId: id, protocolVersion: 1,
        latestSequence: this.database.latestEventSequence() }))
    })
    this.accountWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
    this.accountWss.on('connection', (socket: AccountSocket, request) => {
      try {
        const header = request.headers.authorization || ''
        if (!header.startsWith('Bearer ')) throw new Error('missing bearer')
        socket.accountClaims = this.v2Auth.verify(header.slice(7))
      } catch {
        socket.close(4401, 'unauthorized'); return
      }
      const claims = socket.accountClaims
      this.database.touchAccountDevice(claims.sub, claims.deviceId)
      const devices = this.accountSockets.get(claims.sub) || new Map<string, Set<AccountSocket>>()
      const peers = devices.get(claims.deviceId) || new Set<AccountSocket>()
      peers.add(socket); devices.set(claims.deviceId, peers); this.accountSockets.set(claims.sub, devices)
      socket.on('message', (raw) => this.handleAccount(socket, raw.toString()))
      socket.on('close', () => { peers.delete(socket); if (!peers.size) devices.delete(claims.deviceId); if (!devices.size) this.accountSockets.delete(claims.sub) })
      socket.send(JSON.stringify({ type: 'ready', accountId: claims.sub, deviceId: claims.deviceId, protocolVersion: 2,
        latestSequence: this.database.latestAccountEventSequence(claims.sub), entitlement: this.entitlement.forAccount(claims.sub) }))
    })
    this.upgradeHandler = (request, socket, head) => {
      const path = new URL(request.url || '/', 'http://localhost').pathname
      const target = path === '/bridge/ws' ? this.wss : path === '/bridge/v2/ws' ? this.accountWss : undefined
      if (!target) { socket.destroy(); return }
      target.handleUpgrade(request, socket, head, (webSocket) => target.emit('connection', webSocket, request))
    }
    this.server.on('upgrade', this.upgradeHandler)
  }

  onModuleDestroy(): void {
    if (this.server && this.upgradeHandler) this.server.off('upgrade', this.upgradeHandler)
    for (const peers of this.sockets.values()) for (const socket of peers) socket.terminate()
    for (const devices of this.accountSockets.values()) for (const peers of devices.values()) for (const socket of peers) socket.terminate()
    this.wss?.close(); this.accountWss?.close()
  }

  accountDeviceOnline(accountId: string, deviceId: string): boolean {
    return [...(this.accountSockets.get(accountId)?.get(deviceId) || [])].some(socket => socket.readyState === WebSocket.OPEN)
  }

  accountOnlineCount(accountId?: string): number {
    return [...this.accountSockets].filter(([id]) => !accountId || id === accountId)
      .reduce((sum, [id, devices]) => sum + [...devices.keys()].filter(deviceId => this.accountDeviceOnline(id, deviceId)).length, 0)
  }

  onlineConnectorCount(): number {
    let count = 0
    for (const devices of this.accountSockets.values()) for (const peers of devices.values())
      if ([...peers].some(socket => socket.readyState === WebSocket.OPEN && ['connector', 'desktop'].includes(socket.accountClaims?.type || ''))) count++
    return count
  }

  disconnectAccount(accountId: string, deviceId?: string): void {
    const devices = this.accountSockets.get(accountId)
    if (devices) for (const [id, peers] of devices) if (!deviceId || id === deviceId)
      for (const socket of peers) socket.close(4401, 'Account or device revoked')
  }

  private handle(socket: AuthSocket, raw: string): void {
    try {
      const frame = JSON.parse(raw) as EncryptedFrame
      if (!frame.id || !frame.kind || !frame.nonce || !frame.ciphertext) throw new Error('invalid frame')
      const sourceDeviceId = socket.claims!.deviceId
      const ephemeral = frame.kind === 'file.command' || frame.kind === 'file.result' ||
        frame.kind === 'thread.status.snapshot' || frame.kind === 'connector.presence'
      const sequence = ephemeral ? 0 : this.database.appendEvent(frame, sourceDeviceId)
      const outgoing = JSON.stringify({ ...frame, sourceDeviceId, sequence, createdAt: frame.createdAt || Date.now() })
      for (const [deviceId, peers] of this.sockets) {
        if (deviceId === sourceDeviceId) continue
        if (frame.targetDeviceId && frame.targetDeviceId !== deviceId) continue
        for (const peer of peers) if (peer.readyState === WebSocket.OPEN) peer.send(outgoing)
      }
      socket.send(JSON.stringify({ type: 'ack', id: frame.id, sequence }))
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'invalid frame' }))
    }
  }

  private handleAccount(socket: AccountSocket, raw: string): void {
    try {
      const frame = JSON.parse(raw) as EncryptedFrame
      if (!frame.id || !frame.kind || !frame.nonce || !frame.ciphertext) throw new Error('invalid frame')
      const claims = socket.accountClaims!
      const account = this.database.getAccount(claims.sub)
      const device = this.database.getAccountDevice(claims.sub, claims.deviceId)
      if (!account || account.disabledAt || this.database.isAccountBanned(claims.sub) || !device || device.revokedAt) {
        socket.close(4401, 'Account or device revoked'); return
      }
      if (device.lastSeenAt < Date.now() - 60000) this.database.touchAccountDevice(claims.sub, claims.deviceId)
      const remoteWrite = claims.type === 'android' && ['command', 'command.control', 'file.command', 'approval.resolve'].includes(frame.kind)
      const entitlement = remoteWrite ? this.entitlement.forAccount(claims.sub) : null
      if (entitlement && !entitlement.canWrite) {
        socket.send(JSON.stringify({ type: 'error', code: 'membership_read_only', id: frame.id, message: this.entitlement.readOnlyMessage(entitlement) })); return
      }
      const ephemeral = frame.kind === 'file.command' || frame.kind === 'file.result' ||
        frame.kind === 'thread.status.snapshot' || frame.kind === 'connector.presence'
      const sequence = ephemeral ? 0 : this.database.appendAccountEvent(claims.sub, frame, claims.deviceId)
      const outgoing = JSON.stringify({ ...frame, sourceDeviceId: claims.deviceId, sequence, createdAt: frame.createdAt || Date.now() })
      const devices = this.accountSockets.get(claims.sub) || new Map()
      let delivered = 0
      for (const [deviceId, peers] of devices) {
        if (deviceId === claims.deviceId || (frame.targetDeviceId && frame.targetDeviceId !== deviceId)) continue
        for (const peer of peers) if (peer.readyState === WebSocket.OPEN) { peer.send(outgoing); delivered++ }
      }
      // Content counts toward the month (what came in and what went out);
      // presence and status heartbeats do not.
      if (!CONTROL_FRAMES.has(frame.kind)) this.traffic?.add(claims.sub, Buffer.byteLength(raw) + Buffer.byteLength(outgoing) * delivered)
      socket.send(JSON.stringify({ type: 'ack', id: frame.id, sequence }))
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'invalid frame' }))
    }
  }
}
