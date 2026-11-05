import { pbkdf2Sync, createHmac, randomBytes } from 'node:crypto'

describe('challenge proof', () => {
  it('is deterministic and does not transmit the password', () => {
    const salt = randomBytes(16)
    const verifier = pbkdf2Sync('a sufficiently long password', salt, 10, 32, 'sha256')
    const proof = createHmac('sha256', verifier).update('id|nonce').digest('base64')
    expect(proof).toBe(createHmac('sha256', verifier).update('id|nonce').digest('base64'))
    expect(proof).not.toContain('password')
  })
})

