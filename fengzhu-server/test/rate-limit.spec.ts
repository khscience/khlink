import type { NextFunction, Request, Response } from 'express'
import { createRateLimitMiddleware } from '../src/rate-limit.middleware'

function request(path: string, method = 'POST', address = '10.0.0.1'): Request {
  return { path, method, headers: {}, socket: { remoteAddress: address } } as unknown as Request
}

function response() {
  const headers = new Map<string, string>()
  const result = { statusCode: 200, body: undefined as unknown, headers }
  const response = {
    setHeader(name: string, value: string) { headers.set(name, value); return response },
    status(code: number) { result.statusCode = code; return response },
    json(body: unknown) { result.body = body; return response },
  } as unknown as Response
  return { response, result }
}

describe('v2 request rate limiting', () => {
  it('limits a sensitive route per client and exposes retry metadata', () => {
    const middleware = createRateLimitMiddleware([{ name: 'test', method: 'POST', matches: (path) => path === '/api/v2/test', limit: 1, windowMs: 60_000 }])
    const next = jest.fn() as unknown as NextFunction
    const first = response(); middleware(request('/api/v2/test'), first.response, next)
    const second = response(); middleware(request('/api/v2/test'), second.response, next)
    expect(first.result.statusCode).toBe(200)
    expect(second.result.statusCode).toBe(429)
    expect(second.result.headers.get('Retry-After')).toBeTruthy()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not mix clients or unrelated routes', () => {
    const middleware = createRateLimitMiddleware([{ name: 'test', method: 'POST', matches: (path) => path === '/api/v2/test', limit: 1, windowMs: 60_000 }])
    const next = jest.fn() as unknown as NextFunction
    const first = response(); middleware(request('/api/v2/test', 'POST', '10.0.0.1'), first.response, next)
    const otherClient = response(); middleware(request('/api/v2/test', 'POST', '10.0.0.2'), otherClient.response, next)
    const otherRoute = response(); middleware(request('/api/v2/other', 'POST', '10.0.0.1'), otherRoute.response, next)
    expect(first.result.statusCode).toBe(200)
    expect(otherClient.result.statusCode).toBe(200)
    expect(otherRoute.result.statusCode).toBe(200)
    expect(next).toHaveBeenCalledTimes(3)
  })
})
