'use strict';

// macOS counterpart of the Windows DPAPI envelope used for the connector's
// secrets (account key, refresh token, local stores). A random 32-byte master
// key lives in the user's login Keychain; files only hold AES-256-GCM
// ciphertext. The Keychain is reachable from the user's GUI session (the
// LaunchAgent the connector runs as), not from a plain SSH shell, where it is
// locked: that case fails with a clear message instead of a weaker fallback.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MAGIC = Buffer.from('khlink-macos-v1\0', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SERVICE = 'khLink';
const ACCOUNT = 'connector-master-key-v1';
const SECURITY = '/usr/bin/security';

let cachedKey = null;

function requireKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== KEY_BYTES) throw new Error('khLink macOS 安全存储密钥无效');
  return value;
}

function encryptWithKey(value, key, nonce = crypto.randomBytes(NONCE_BYTES)) {
  requireKey(key);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decryptWithKey(value, key) {
  requireKey(key);
  const raw = Buffer.from(String(value || ''), 'base64');
  if (raw.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('khLink macOS 安全存储数据格式无效');
  }
  const nonce = raw.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = raw.subarray(MAGIC.length + NONCE_BYTES, MAGIC.length + NONCE_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(MAGIC.length + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('khLink macOS 安全存储验证失败（钥匙串里的密钥不匹配）');
  }
}

function keychainError(error) {
  const text = String(error?.stderr || error?.message || '');
  if (/interaction is not allowed|could not be unlocked/i.test(text)) {
    return new Error('khLink 无法访问 macOS 钥匙串：请在 Mac 的登录会话中运行（LaunchAgent 或终端 App），SSH 会话里钥匙串是锁着的');
  }
  return new Error(`khLink 无法访问 macOS 钥匙串：${text.trim().split('\n').pop() || 'unknown error'}`);
}

// Defaults talk to /usr/bin/security; tests pass their own.
function defaultKeychain() {
  return {
    read() {
      try {
        return execFileSync(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
          { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (error) {
        // 44: item not found. Anything else (locked keychain) is an error.
        if (error?.status === 44) return null;
        throw keychainError(error);
      }
    },
    write(value) {
      // Through `security -i` stdin, so the key never appears in a process
      // argument list (visible to every user on macOS).
      try {
        execFileSync(SECURITY, ['-i'], {
          input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "khLink connector" -w ${value}\n`,
          encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) { throw keychainError(error); }
    },
  };
}

function masterKey(customKeychain = null) {
  if (cachedKey && !customKeychain) return cachedKey;
  const keychain = customKeychain || defaultKeychain();
  let stored = keychain.read();
  if (!stored) {
    keychain.write(crypto.randomBytes(KEY_BYTES).toString('base64'));
    stored = keychain.read();
    if (!stored) throw new Error('khLink 写入 macOS 钥匙串后读不回密钥');
  }
  const key = requireKey(Buffer.from(stored, 'base64'));
  if (!customKeychain) cachedKey = key;
  return key;
}

function protect(value) { return encryptWithKey(value, masterKey()); }
function unprotect(value) { return decryptWithKey(value, masterKey()); }

function resetCacheForTests() { cachedKey = null; }

module.exports = { protect, unprotect, encryptWithKey, decryptWithKey, masterKey, resetCacheForTests, SERVICE, ACCOUNT };
