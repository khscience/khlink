const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../src/connector');
const { ready, encryptJson } = require('../src/crypto');

// One account, several computers sharing the account key: a command the phone
// addressed to another computer must not run here too.
test('a command addressed to another computer is skipped; one addressed here runs', async () => {
  await ready();
  const key = Buffer.alloc(32, 3);
  const connector = Object.create(Connector.prototype);
  const ran = []; const saved = []; const emitted = [];
  connector.config = { accountKey: key, deviceId: 'pc-a.connector' };
  connector.inFlightCommands = new Set();
  connector.saveSequence = (sequence) => saved.push(sequence);
  connector.command = async (payload) => { ran.push(payload.action); return { ok: true }; };
  connector.emit = (kind, threadId, data) => emitted.push(kind);
  connector.log = () => {};
  const frame = (id, target, sequence) => ({ id, kind: 'command', threadId: null, targetDeviceId: target, sourceDeviceId: 'phone-1', sequence,
    ...encryptJson(key, 'command', null, id, { action: 'capabilities', args: {} }) });
  await connector.onFrame(JSON.stringify(frame('f1', 'pc-b.connector', 7)));
  assert.deepEqual(ran, []);
  assert.deepEqual(saved, [7], 'the sequence still advances past it');
  await connector.onFrame(JSON.stringify(frame('f2', 'pc-a.connector', 8)));
  await connector.onFrame(JSON.stringify(frame('f3', null, 9)));
  assert.deepEqual(ran, ['capabilities', 'capabilities'], 'addressed here, or unaddressed from an older phone');
});
