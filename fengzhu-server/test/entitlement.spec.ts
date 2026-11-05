import { resolveKhLinkEntitlement } from '../src/entitlement.service'
import { EntitlementService } from '../src/entitlement.service'

const inactive = { state: 'expired' as const, plan: 'Expired', expiresAt: 10 }
const now = 1_000

describe('nested KH Link membership', () => {
  it('includes KH Link for an active khQuant VIP without creating a direct subscription', () => {
    expect(resolveKhLinkEntitlement({ state: 'active', plan: 'khQuant VIP', expiresAt: 1_100 }, inactive, now)).toEqual({
      state: 'active', source: 'khquant', plan: 'khQuant VIP', expiresAt: 1_100, canWrite: true,
    })
  })

  it('allows a direct KH Link subscription when khQuant is not VIP', () => {
    expect(resolveKhLinkEntitlement(inactive, { state: 'active', plan: 'KH Link VIP', expiresAt: 1_200 }, now)).toEqual({
      state: 'active', source: 'kh_link', plan: 'KH Link VIP', expiresAt: 1_200, canWrite: true,
    })
  })

  it('keeps access when either independent benefit is valid and reports their combined state', () => {
    expect(resolveKhLinkEntitlement({ state: 'expiring', plan: 'khQuant VIP', expiresAt: 1_100 }, { state: 'active', plan: 'KH Link VIP', expiresAt: 1_200 }, now)).toEqual({
      state: 'active', source: 'combined', plan: 'khQuant VIP + KH Link VIP', expiresAt: 1_200, canWrite: true,
    })
  })

  it('denies writes when neither nested benefit is valid', () => {
    expect(resolveKhLinkEntitlement(inactive, { state: 'payment_pending' }, now)).toMatchObject({ source: 'none', canWrite: false, state: 'payment_pending' })
  })

  it('loads independent benefits only from the requested account', () => {
    const database = { listEntitlements: jest.fn().mockReturnValue([
      { accountId: 'account-a', product: 'khquant', state: 'expired', plan: 'khQuant VIP', expiresAt: 10, updatedAt: 1 },
      { accountId: 'account-a', product: 'kh_link', state: 'active', plan: 'KH Link VIP', expiresAt: Date.now() + 60_000, updatedAt: 2 },
    ]) }
    const service = new EntitlementService(database as never)

    expect(service.forAccount('account-a')).toEqual({
      state: 'active', source: 'kh_link', plan: 'KH Link VIP', expiresAt: expect.any(Number), canWrite: true,
    })
    expect(database.listEntitlements).toHaveBeenCalledWith('account-a')
  })

  it('does not grant access after an active entitlement expires', () => {
    expect(resolveKhLinkEntitlement({ state: 'active', plan: 'KH Link VIP', expiresAt: 999 }, { state: 'unavailable' }, 1_000))
      .toMatchObject({ source: 'none', canWrite: false, state: 'expired' })
  })
})
