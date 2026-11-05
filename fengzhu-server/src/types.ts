export type DeviceType = 'android' | 'connector' | 'desktop'

export interface AuthDevice {
  id: string
  name: string
  type: DeviceType
  revokedAt: number | null
}

export interface AccessClaims {
  sub: 'admin'
  deviceId: string
  type: DeviceType
  exp: number
}

export interface AccountAccessClaims {
  sub: string
  deviceId: string
  type: DeviceType
  exp: number
  version: 2
}

export interface AccountProfile {
  id: string
  khQuantSubject: string
  displayName: string
  avatarUrl?: string
  disabledAt?: number
}

export interface AccountDevice extends AuthDevice {
  accountId: string
  publicKey?: string
  keyEnvelope?: string
  lastSeenAt: number
  createdAt: number
}

export interface EncryptedFrame {
  id: string
  kind: string
  sourceDeviceId?: string
  targetDeviceId?: string | null
  threadId?: string | null
  nonce: string
  ciphertext: string
  createdAt?: number
  sequence?: number
}

export type MembershipState = 'active' | 'expiring' | 'expired' | 'payment_pending' | 'account_exception' | 'unavailable'

export interface KhQuantProfile {
  subject: string
  displayName: string
  avatarUrl?: string
  disabled: boolean
}

export interface KhQuantMembership {
  state: MembershipState
  plan?: string
  expiresAt?: number
}

export type EntitlementProduct = 'khquant' | 'kh_link'

export interface StoredEntitlement extends KhQuantMembership {
  accountId: string
  product: EntitlementProduct
  providerSubscriptionId?: string
  providerEventId?: string
  updatedAt: number
}

export type EntitlementSource = 'khquant' | 'kh_link' | 'combined' | 'free' | 'none'

export interface KhLinkEntitlement {
  state: MembershipState
  source: EntitlementSource
  plan?: string
  expiresAt?: number
  canWrite: boolean
  /** This month's traffic through the relay, when it has a free allowance. */
  traffic?: { month: string; usedBytes: number; limitBytes: number; resetsAt: number }
}
