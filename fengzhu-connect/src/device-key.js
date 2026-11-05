// Wrap the account key for a phone that logged in with its khsci.com account.
// The phone registered its X25519 public key with the relay but has no key yet;
// the connector (which holds the account key) seals the key to that public key
// with an ephemeral X25519 keypair, so the relay only ever stores ciphertext and
// the account key stays end-to-end encrypted. The phone unwraps with its private
// key. This mirrors the QR pairing envelope but uses its own label/AAD.
const crypto = require('node:crypto');
const sodium = require('libsodium-wrappers-sumo');

const LABEL = 'KH Link device-key v3';
const VERSION = 3;

function deriveKey(shared, deviceId) {
  return crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(LABEL), Buffer.from(shared), Buffer.from(String(deviceId))]))
    .digest();
}

function aad(accountId, deviceId) {
  return Buffer.from(`kh-link-device-key-v3|${accountId}|${deviceId}`);
}

function keyBuffer(accountKey) {
  const buffer = Buffer.isBuffer(accountKey) ? accountKey : Buffer.from(accountKey, 'base64');
  if (buffer.length !== 32) throw new Error('account key must be 32 bytes');
  return buffer;
}

// Returns the envelope object (JSON-serialisable). accountId/deviceId are bound
// into the AAD so an envelope cannot be replayed for a different phone.
function wrapAccountKey(accountKey, phonePublicKeyBase64, accountId, deviceId) {
  const phonePublic = Buffer.from(String(phonePublicKeyBase64), 'base64');
  if (phonePublic.length !== 32) throw new Error('phone public key must be 32 bytes');
  const ephemeral = sodium.crypto_box_keypair();
  const shared = sodium.crypto_scalarmult(ephemeral.privateKey, phonePublic);
  const key = deriveKey(shared, deviceId);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(keyBuffer(accountKey), aad(accountId, deviceId), null, nonce, key);
  return {
    version: VERSION,
    algorithm: 'X25519-XChaCha20-Poly1305',
    senderPublicKey: Buffer.from(ephemeral.publicKey).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
    ciphertext: Buffer.from(cipher).toString('base64'),
  };
}

// Phone-side counterpart, kept here so tests can prove round-trip and AAD binding.
function unwrapAccountKey(envelope, phonePrivateKey, accountId, deviceId) {
  const shared = sodium.crypto_scalarmult(Buffer.from(phonePrivateKey), Buffer.from(envelope.senderPublicKey, 'base64'));
  const key = deriveKey(shared, deviceId);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,
    Buffer.from(envelope.ciphertext, 'base64'), aad(accountId, deviceId), Buffer.from(envelope.nonce, 'base64'), key);
  return Buffer.from(plain);
}

module.exports = { wrapAccountKey, unwrapAccountKey, VERSION };
