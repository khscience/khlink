import type { NextFunction, Request, RequestHandler, Response } from 'express'

type Rule = {
  name: string
  method: string
  matches: (path: string) => boolean
  limit: number
  windowMs: number
  key?: (request: Request) => string
}

type Bucket = { count: number; resetAt: number }

function clientAddress(request: Request): string {
  const forwarded = request.headers['x-real-ip'] || request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return String(value || request.socket.remoteAddress || 'unknown').split(',')[0].trim()
}

export function createRateLimitMiddleware(rules: Rule[]): RequestHandler {
  const buckets = new Map<string, Bucket>()
  let lastPruneAt = 0

  return (request: Request, response: Response, next: NextFunction) => {
    const paths = [request.path, request.originalUrl, request.url]
      .filter(Boolean)
      .map((value) => String(value).split('?')[0].replace(/\/+$/, '') || '/')
    const rule = rules.find((candidate) => candidate.method === request.method && paths.some((path) => candidate.matches(path)))
    if (!rule) return next()

    const now = Date.now()
    if (now - lastPruneAt > 60_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
      lastPruneAt = now
    }
    const suffix = rule.key ? rule.key(request) : ''
    const key = `${rule.name}|${clientAddress(request)}|${suffix}`
    const current = buckets.get(key)
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + rule.windowMs }
    bucket.count += 1
    buckets.set(key, bucket)
    response.setHeader('X-RateLimit-Limit', String(rule.limit))
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, rule.limit - bucket.count)))
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)))
    if (bucket.count > rule.limit) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
      response.status(429).json({ code: 'rate_limited', message: '请求过于频繁，请稍后再试' })
      return
    }
    next()
  }
}

export const v2RateLimitRules: Rule[] = [
  { name: 'v2-oauth-authorization', method: 'POST', matches: (path) => path.endsWith('/api/v2/session/oauth/authorization') || path.endsWith('/v2/session/oauth/authorization'), limit: 20, windowMs: 60_000 },
  { name: 'v2-oauth-complete', method: 'POST', matches: (path) => path.endsWith('/api/v2/session/oauth/complete') || path.endsWith('/v2/session/oauth/complete'), limit: 10, windowMs: 60_000 },
  { name: 'v2-session-refresh', method: 'POST', matches: (path) => path.endsWith('/api/v2/session/refresh') || path.endsWith('/v2/session/refresh'), limit: 20, windowMs: 60_000 },
  { name: 'v2-pairing-claim', method: 'POST', matches: (path) => path.endsWith('/api/v2/pairing/claim') || path.endsWith('/v2/pairing/claim'), limit: 20, windowMs: 60_000 },
  { name: 'v2-pairing-poll', method: 'POST', matches: (path) => /(?:^|\/)v2\/pairing\/[^/]+\/poll$/.test(path), limit: 120, windowMs: 60_000,
    key: (request) => String(request.params?.id || request.path.split('/')[4] || '') },
]
