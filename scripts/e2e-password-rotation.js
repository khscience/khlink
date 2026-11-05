const crypto = require('node:crypto');
const { BridgeApi } = require('../fengzhu-connect/src/api');
const { loadConfig } = require('../fengzhu-connect/src/config');
const { ready, deriveAccountKey, loginProof, wrapAccountKey, unwrapAccountKey } = require('../fengzhu-connect/src/crypto');

async function raw(url, body, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); return response.json();
}

async function material(password, accountKey) {
  const salt = crypto.randomBytes(16); const iterations = 310_000; const verifier = deriveAccountKey(password, salt.toString('base64'), iterations);
  return { salt: salt.toString('base64'), verifier: verifier.toString('base64'), iterations, keyEnvelope: wrapAccountKey(verifier, accountKey) };
}

async function main() {
  await ready(); const original = process.env.FENGZHU_BRIDGE_PASSWORD; if (!original) throw new Error('FENGZHU_BRIDGE_PASSWORD is required');
  const config = loadConfig(); const api = new BridgeApi(config); const accountKey = Buffer.from(config.accountKey, 'base64');
  const temporary = crypto.randomBytes(24).toString('base64url'); const token = await api.token();
  const restore = await material(original, accountKey); let changed = false;
  try {
    await raw(`${config.serverUrl}/api/v1/auth/change-password`, await material(temporary, accountKey), token); changed = true;
    const challenge = await raw(`${config.serverUrl}/api/v1/auth/challenge`, {}); const passwordKey = deriveAccountKey(temporary, challenge.salt, challenge.iterations);
    const login = await raw(`${config.serverUrl}/api/v1/auth/login`, { challengeId: challenge.challengeId,
      proof: loginProof(passwordKey, challenge.challengeId, challenge.nonce), deviceId: `e2e-password-${crypto.randomUUID()}`,
      deviceName: 'Password rotation verifier', deviceType: 'android' });
    if (!unwrapAccountKey(passwordKey, login.keyEnvelope).equals(accountKey)) throw new Error('Unwrapped account key changed');
    console.log('passwordRotation=true accountKeyPreserved=true');
  } finally {
    if (changed) await raw(`${config.serverUrl}/api/v1/auth/change-password`, restore, token);
  }
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
