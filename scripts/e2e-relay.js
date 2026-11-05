const crypto = require('node:crypto');
const WebSocket = require('ws');
const { ready, deriveAccountKey, loginProof, encryptJson, decryptJson, unwrapAccountKey } = require('../fengzhu-connect/src/crypto');

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  await ready();
  const server = process.env.FENGZHU_BRIDGE_URL;
  if (!server) throw new Error('FENGZHU_BRIDGE_URL is required');
  const password = process.env.FENGZHU_BRIDGE_PASSWORD;
  if (!password) throw new Error('FENGZHU_BRIDGE_PASSWORD is required');
  async function loginDevice(name) {
    const challenge = await json(`${server}/api/v1/auth/challenge`, { method: 'POST', body: {} });
    const passwordKey = deriveAccountKey(password, challenge.salt, challenge.iterations); const deviceId = `e2e-${crypto.randomUUID()}`;
    const login = await json(`${server}/api/v1/auth/login`, { method: 'POST', body: { challengeId: challenge.challengeId,
      proof: loginProof(passwordKey, challenge.challengeId, challenge.nonce), deviceId, deviceName: name, deviceType: 'android' } });
    const key = unwrapAccountKey(passwordKey, login.keyEnvelope);
    const ws = new WebSocket(server.replace(/^http/, 'ws') + '/bridge/ws', { headers: { Authorization: `Bearer ${login.accessToken}` } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { key, deviceId, ws };
  }
  const first = await loginDevice('E2E verifier A'); const { key, deviceId, ws } = first;
  const requestId = crypto.randomUUID(); const id = crypto.randomUUID();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Encrypted relay timed out')), 30_000);
    ws.send(JSON.stringify({ id, kind: 'command', threadId: null, createdAt: Date.now(),
      ...encryptJson(key, 'command', null, id, { requestId, action: 'capabilities', args: {} }) }));
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()); if (frame.type || frame.kind !== 'command.result') return;
      const value = decryptJson(key, frame); if (value.requestId !== requestId) return;
      clearTimeout(timer); resolve(value);
    });
    ws.on('error', reject);
  });
  const second = await loginDevice('E2E verifier B'); const lockThread = `e2e-lock-${crypto.randomUUID()}`;
  const lockRequest = crypto.randomUUID(); const lockFrameId = crypto.randomUUID();
  ws.send(JSON.stringify({ id: lockFrameId, kind: 'command.control', threadId: lockThread, createdAt: Date.now(),
    ...encryptJson(key, 'command.control', lockThread, lockFrameId, { requestId: lockRequest, action: 'settings.set', args: { threadId: lockThread, settings: {} } }) }));
  await new Promise((resolve) => { const handler = (raw) => { const frame = JSON.parse(raw.toString()); if (frame.kind !== 'command.result') return;
    const value = decryptJson(key, frame); if (value.requestId === lockRequest) { ws.off('message', handler); resolve(); } }; ws.on('message', handler); });
  const conflictId = crypto.randomUUID();
  const lockConflict = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Lock check timed out')), 10_000);
    second.ws.on('message', (raw) => { const frame = JSON.parse(raw.toString()); if (frame.type === 'error' && frame.code === 'thread_locked') { clearTimeout(timer); resolve(true); } });
    second.ws.send(JSON.stringify({ id: conflictId, kind: 'command.control', threadId: lockThread, createdAt: Date.now(),
      ...encryptJson(second.key, 'command.control', lockThread, conflictId, { requestId: conflictId, action: 'settings.set', args: { threadId: lockThread, settings: {} } }) }));
  });
  const releaseId = crypto.randomUUID(); ws.send(JSON.stringify({ id: releaseId, kind: 'control.release', threadId: lockThread, createdAt: Date.now(),
    ...encryptJson(key, 'control.release', lockThread, releaseId, { reason: 'e2e_complete' }) }));
  const fileRequest = crypto.randomUUID(); const fileFrame = crypto.randomUUID();
  const fileResult = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('File relay timed out')), 10_000);
    const handler = (raw) => { const frame = JSON.parse(raw.toString()); if (frame.kind !== 'file.result') return; const value = decryptJson(key, frame);
      if (value.requestId === fileRequest) { clearTimeout(timer); ws.off('message', handler); resolve(value); } }; ws.on('message', handler);
    ws.send(JSON.stringify({ id: fileFrame, kind: 'file.command', threadId: null, createdAt: Date.now(),
      ...encryptJson(key, 'file.command', null, fileFrame, { requestId: fileRequest, action: 'file.list', args: { path: '', limit: 20 } }) }));
  });
  ws.close(); second.ws.close();
  console.log(JSON.stringify({ deviceId, encryptedRoundTrip: result.ok,
    lockConflict,
    ephemeralFileRelay: fileResult.ok && Array.isArray(fileResult.result?.items),
    modelCount: result.result?.[0]?.data?.length || result.result?.[0]?.models?.length || 0,
    firstModel: result.result?.[0]?.data?.[0] || result.result?.[0]?.models?.[0] || null,
    rateLimits: result.result?.[1] || null,
    codex: result.result?.[2] || null }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
