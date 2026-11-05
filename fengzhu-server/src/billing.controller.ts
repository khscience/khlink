import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { serviceSecret } from './admin.guard'
import { DatabaseService } from './database.service'
import type { MembershipState } from './types'

@Controller('v2/billing')
export class BillingController {
  constructor(private readonly database: DatabaseService) {}

  private validate(body: BillingInput): void {
    const states: MembershipState[] = ['active', 'expiring', 'expired', 'payment_pending', 'account_exception', 'unavailable']
    if ((!body.subject && !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.accountId || '')) || (body.subject !== undefined && !/^[1-9]\d{0,19}$/.test(body.subject)) || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.eventId || '')) {
      throw new BadRequestException('Invalid billing identity')
    }
    if (!states.includes(body.state)) throw new BadRequestException('Invalid membership state')
    if (!Number.isFinite(Number(body.timestamp))) throw new BadRequestException('Invalid billing timestamp')
    if (Math.abs(Date.now() - Number(body.timestamp)) > 5 * 60_000) throw new UnauthorizedException('Billing event expired')
    if (body.plan !== undefined && body.plan.length > 200) throw new BadRequestException('Invalid billing plan')
    if (body.subscriptionId !== undefined && !/^[a-zA-Z0-9._:-]{1,200}$/.test(body.subscriptionId)) throw new BadRequestException('Invalid subscription')
    if (body.expiresAt !== undefined && (!Number.isFinite(Number(body.expiresAt)) || Number(body.expiresAt) <= 0)) {
      throw new BadRequestException('Invalid expiry')
    }
    if (body.subject && (!Number.isSafeInteger(body.occurredAt) || Number(body.occurredAt) <= 0 || Number(body.occurredAt) > Date.now() + 300_000)) throw new BadRequestException('Invalid event time')
  }

  @Post('webhook')
  webhook(@Headers('x-khlink-signature') signature: string | undefined,
    @Body() body: BillingInput): object {
    const secret = serviceSecret(body.subject ? 'KH_LINK_BILLING_SITE_SECRET' : 'KH_LINK_BILLING_WEBHOOK_SECRET')
    if (secret.length < 32) throw new UnauthorizedException('Invalid billing event')
    this.validate(body)
    const payload = billingPayload(body)
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    const actual = signature || ''
    if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new UnauthorizedException('Invalid billing signature')
    if (body.subject) {
      const stable = [body.subject, body.state, body.plan || '', body.expiresAt || '', body.subscriptionId || '', body.eventId, body.occurredAt].join('|')
      try {
        return this.database.applySubjectEntitlement(body.subject, { state: body.state, plan: body.plan, expiresAt: body.expiresAt,
          providerSubscriptionId: body.subscriptionId, providerEventId: body.eventId, updatedAt: body.occurredAt! }, createHash('sha256').update(stable).digest('hex'))
      } catch { throw new BadRequestException('Billing event identity conflict') }
    }
    if (!this.database.getAccount(body.accountId!)) throw new UnauthorizedException('Unknown account')
    const changed = this.database.upsertEntitlement({ accountId: body.accountId!, product: 'kh_link', state: body.state,
      plan: body.plan, expiresAt: body.expiresAt, providerSubscriptionId: body.subscriptionId, providerEventId: body.eventId, updatedAt: body.timestamp })
    return { accepted: true, changed }
  }
}

export interface BillingInput {
  accountId?: string; subject?: string; state: MembershipState; plan?: string; expiresAt?: number; subscriptionId?: string;
  eventId: string; timestamp: number; occurredAt?: number
}

export function billingPayload(body: BillingInput): string {
  const fields = [body.subject ? `subject:${body.subject}` : body.accountId, body.state, body.plan || '', body.expiresAt || '', body.subscriptionId || '', body.eventId, body.timestamp]
  if (body.subject) fields.push(body.occurredAt!)
  return fields.join('|')
}
