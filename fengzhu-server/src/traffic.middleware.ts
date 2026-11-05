import type { NextFunction, Request, Response } from 'express'
import type { TrafficService } from './traffic.service'
import type { AccountAccessClaims } from './types'

// History and event catch-up are the bulk of an account's relay traffic: a
// phone reading a conversation, the connector mirroring it. Both directions
// count. The account comes from the bearer token, which the route's guard has
// verified by the time the response finishes.
const COUNTED = /^\/api\/v2\/(history|events)(\/|\?|$)/

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
      traffic.add(claims.sub, (Number(req.headers['content-length']) || 0) + sent)
    })
    next()
  }
}
