const crypto = require('node:crypto');
const sodium = require('libsodium-wrappers-sumo');

async function ready() { await sodium.ready; }

function deriveAccountKey(password, saltBase64, iterations) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltBase64, 'base64'), iterations, 32, 'sha256');
}

function loginProof(key, challengeId, nonce) {
  return crypto.createHmac('sha256', key).update(`${challengeId}|${nonce}`).digest('base64');
}

function keyBytes(key) { return Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64'); }

function encryptJson(key, kind, threadId, id, value) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = Buffer.from(`v1|${kind}|${threadId || ''}|${id}`);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, aad, null, nonce, keyBytes(key));
  return { nonce: Buffer.from(nonce).toString('base64'), ciphertext: Buffer.from(cipher).toString('base64') };
}

// A file chunk travels as raw bytes beside the JSON payload, sealed with the
// frame's id, so it is base64-encoded once instead of twice (data inside the
// JSON, then the JSON itself).
function encryptBlob(key, id, bytes) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, Buffer.from(`v1|file.blob|${id}`), null, nonce, keyBytes(key));
  return { blobNonce: Buffer.from(nonce).toString('base64'), blob: Buffer.from(cipher).toString('base64') };
}

// file.read puts a chunk's bytes under this key; JSON.stringify skips symbol keys.
const FILE_BLOB = Symbol('fileBlob');

/** The blob fields for an outgoing frame whose result carries a chunk, else nothing. */
function blobFields(key, id, value) {
  const bytes = value?.result?.[FILE_BLOB];
  return Buffer.isBuffer(bytes) ? encryptBlob(key, id, bytes) : {};
}

function decryptBlob(key, frame) {
  return Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,
    Buffer.from(frame.blob, 'base64'), Buffer.from(`v1|file.blob|${frame.id}`), Buffer.from(frame.blobNonce, 'base64'), keyBytes(key)));
}

function decryptJson(key, frame) {
  const aad = Buffer.from(`v1|${frame.kind}|${frame.threadId || ''}|${frame.id}`);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,
    Buffer.from(frame.ciphertext, 'base64'), aad, Buffer.from(frame.nonce, 'base64'), keyBytes(key));
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}

function wrapAccountKey(passwordKey, accountKey) {
  return encryptJson(passwordKey, 'account.envelope', null, 'master', { key: keyBytes(accountKey).toString('base64') });
}

function unwrapAccountKey(passwordKey, envelope) {
  return Buffer.from(decryptJson(passwordKey, { id: 'master', kind: 'account.envelope', threadId: null, ...envelope }).key, 'base64');
}

module.exports = { ready, deriveAccountKey, loginProof, encryptJson, decryptJson, encryptBlob, decryptBlob, blobFields, FILE_BLOB, wrapAccountKey, unwrapAccountKey };
