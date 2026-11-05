import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { EntitlementService } from './entitlement.service'
import type { AccountAccessClaims } from './types'
import { V2AuthService } from './v2-auth.service'

export type V2Request = Request & { accountClaims: AccountAccessClaims }

@Injectable()
export class V2AuthGuard implements CanActivate {
  constructor(private readonly auth: V2AuthService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<V2Request>()
    const header = request.headers.authorization || ''
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token')
    request.accountClaims = this.auth.verify(header.slice(7))
    return true
  }
}

@Injectable()
export class V2WriteGuard implements CanActivate {
  constructor(private readonly entitlement: EntitlementService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<V2Request>()
    if (!request.accountClaims) throw new UnauthorizedException('Missing account claims')
    if (!this.entitlement.forAccount(request.accountClaims.sub).canWrite) {
      throw new ForbiddenException('KH Link membership is read-only')
    }
    return true
  }
}
