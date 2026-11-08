import { Injectable, Optional } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { TrafficService } from './traffic.service'
import type { KhLinkEntitlement, KhQuantMembership, MembershipState, StoredEntitlement } from './types'

function grantsAccess(membership: KhQuantMembership, now = Date.now()): boolean {
  if (membership.state !== 'active' && membership.state !== 'expiring') return false
  return membership.expiresAt === undefined || membership.expiresAt > now
}

function preferredState(memberships: KhQuantMembership[], now = Date.now()): MembershipState {
  if (memberships.some((membership) => grantsAccess(membership, now) && membership.state === 'active')) return 'active'
  if (memberships.some((membership) => grantsAccess(membership, now) && membership.state === 'expiring')) return 'expiring'
  if (memberships.some((membership) => membership.state === 'payment_pending')) return 'payment_pending'
  if (memberships.some((membership) => membership.state === 'account_exception')) return 'account_exception'
  if (memberships.some((membership) => membership.state === 'expired')) return 'expired'
  if (memberships.some((membership) => membership.state === 'active' || membership.state === 'expiring')) return 'expired'
  return 'unavailable'
}

export function resolveKhLinkEntitlement(khQuant: KhQuantMembership, direct: KhQuantMembership, now = Date.now()): KhLinkEntitlement {
  const providers = [
    ...(grantsAccess(khQuant, now) ? [{ source: 'khquant' as const, membership: khQuant }] : []),
    ...(grantsAccess(direct, now) ? [{ source: 'kh_link' as const, membership: direct }] : []),
  ]
  const state = preferredState([khQuant, direct], now)
  if (!providers.length) return { state, source: 'none', plan: direct.plan || khQuant.plan, expiresAt: direct.expiresAt || khQuant.expiresAt, canWrite: false }
  const source = providers.length === 2 ? 'combined' : providers[0].source
  const expiresAt = providers.map((item) => item.membership.expiresAt).filter((value): value is number => typeof value === 'number').sort((a, b) => b - a)[0]
  const plan = providers.map((item) => item.membership.plan).filter(Boolean).join(' + ') || undefined
  return { state, source, plan, expiresAt, canWrite: true }
}

@Injectable()
export class EntitlementService {
  constructor(private readonly database: DatabaseService, @Optional() private readonly traffic?: TrafficService) {}

  resolve(khQuant: KhQuantMembership, direct: KhQuantMembership): KhLinkEntitlement {
    return resolveKhLinkEntitlement(khQuant, direct)
  }

  forAccount(accountId: string): KhLinkEntitlement {
    const entries = this.database.listEntitlements(accountId)
    const membership = resolveKhLinkEntitlement(
      this.membership(entries.find((entry) => entry.product === 'khquant')),
      this.membership(entries.find((entry) => entry.product === 'kh_link')),
    )
    // The official relay lets an account without a membership use it up to a
    // monthly allowance; members are never limited. Self-hosted relays set no
    // allowance and behave as before.
    if (!this.traffic?.freeMonthlyBytes) return membership
    const traffic = this.traffic.usage(accountId)
    if (membership.canWrite) return { ...membership, traffic }
    return { ...membership, source: 'free', canWrite: traffic.usedBytes < traffic.limitBytes, traffic }
  }

  /** What a refused remote action tells the user (shown as is by older phones). */
  readOnlyMessage(entitlement: KhLinkEntitlement): string {
    return entitlement.source === 'free'
      ? '本月免费流量已用完，远程操作暂停到下月 1 日；扫码直连不计流量，可以改用直连'
      : '这个账号当前不能远程操作，可以改用扫码直连'
  }

  private membership(entry: StoredEntitlement | undefined): KhQuantMembership {
    return entry ? { state: entry.state, plan: entry.plan, expiresAt: entry.expiresAt } : { state: 'unavailable' }
  }
}
