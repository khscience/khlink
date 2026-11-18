import type { NextFunction, Request, Response } from 'express'
import type { TrafficService } from './traffic.service'
import type { AccountAccessClaims } from './types'

// History and event catch-up are the bulk of an account's relay traffic: a
// phone reading a conversation, the connector mirroring it. Both directions
// count. The account comes from the bearer token, which the route's guard has
// verified by the time the response finishes.
const COUNTED = /^\/api\/v2\/(history|events)(\/|\?|$)/

/** History rows this large are counted apart: nearly always images. */
export const LARGE_HISTORY_ROW_BYTES = 100 * 1024

/** What a counted request was for, from its method and route. */
export function trafficCategory(method: string | undefined, url: string): string {
  method = String(method || 'GET')
  const path = url.split('?')[0]
  const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
  const verb = method.toUpperCase() === 'GET' ? 'read' : method.toUpperCase() === 'PUT' ? 'upload' : method.toLowerCase()
  if (/^\/api\/v2\/events(\/|$)/.test(path)) return `events.${verb}`
  if (/^\/api\/v2\/history\/threads\/?$/.test(path)) return `history.threads.${verb}${verb === 'read' && /[?&]since=/.test(query) ? '.changes' : ''}`
  if (/^\/api\/v2\/history\/threads\/[^/]+\/items\/?$/.test(path)) {
    return `history.items.${verb}${verb === 'read' && /[?&]changedSince=/.test(query) ? '.changes' : ''}`
  }
  const rest = path.replace(/^\/api\/v2\/history\/?/, '').split('/').filter(part => !/^[0-9a-f-]{16,}$|^local_|^hermes-/i.test(part)).slice(0, 2).join('.')
  return `history.${rest || 'other'}.${verb}`
}

/** Bytes of the given rows' ciphertext that belong to large rows. */
export function largeRowBytes(rows: unknown): number {
  if (!Array.isArray(rows)) return 0
  let bytes = 0
  for (const row of rows) {
    const length = typeof (row as { ciphertext?: unknown })?.ciphertext === 'string' ? (row as { ciphertext: string }).ciphertext.length : 0
    if (length >= LARGE_HISTORY_ROW_BYTES) bytes += length
  }
  return bytes
}

export function createTrafficMiddleware(traffic: TrafficService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!traffic.freeMonthlyBytes || !COUNTED.test(req.originalUrl || req.url)) { next(); return }
    let sent = 0
    const write = res.write.bind(res) as (...args: unknown[]) => boolean
    const end = res.end.bind(res) as (...args: unknown[]) => Response
    const size = (chunk: unknown, encoding?: unknown) => typeof chunk === 'string'
      ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
      : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.length : 0
    ;(res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => { sent += size(args[0], args[1]); return write(...args) }
    ;(res as unknown as { end: (...args: unknown[]) => Response }).end = (...args: unknown[]) => { if (args[0] && typeof args[0] !== 'function') sent += size(args[0], args[1]); return end(...args) }
    res.on('finish', () => {
      const claims = (req as Request & { accountClaims?: AccountAccessClaims }).accountClaims
      if (!claims?.sub || res.statusCode >= 400) return
      const received = Number(req.headers['content-length']) || 0
      traffic.add(claims.sub, received + sent)
      traffic.addDevice(claims.sub, claims.deviceId, received, sent)
      // Split large rows (images) from the rest: uploads from the parsed body,
      // reads from what the history controller noted it returned.
      const category = trafficCategory(req.method, req.originalUrl || req.url)
      const largeUp = Math.min(received, largeRowBytes((req.body as { items?: unknown } | undefined)?.items))
      const largeDown = Math.min(sent, Number((res.locals as { largeHistoryBytes?: number } | undefined)?.largeHistoryBytes) || 0)
      if (largeUp || largeDown) traffic.addCategory(claims.sub, `${category}.large`, largeUp, largeDown, Date.now(), 0)
      traffic.addCategory(claims.sub, category, received - largeUp, sent - largeDown)
    })
    next()
  }
}
