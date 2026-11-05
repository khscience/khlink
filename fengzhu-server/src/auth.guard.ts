import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service'
import type { AccessClaims } from './types'

export type AuthRequest = Request & { claims: AccessClaims }

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>()
    const header = request.headers.authorization || ''
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token required')
    request.claims = this.auth.verifyAccess(header.slice(7))
    return true
  }
}

