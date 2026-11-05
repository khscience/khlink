// Account login uses device-key v3. Pairing v2 has a different key derivation
// and AAD, so its envelope must stay in the one-time pairing session.
export function isDeviceKeyEnvelope(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false
  try {
    const envelope = JSON.parse(value)
    return envelope?.version === 3 && envelope.algorithm === 'X25519-XChaCha20-Poly1305'
      && isBase64Bytes(envelope.senderPublicKey, 32)
      && isBase64Bytes(envelope.nonce, 24)
      && isBase64Bytes(envelope.ciphertext, 48)
  } catch {
    return false
  }
}

function isBase64Bytes(value: unknown, bytes: number): boolean {
  if (typeof value !== 'string') return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === bytes && decoded.toString('base64') === value
}
