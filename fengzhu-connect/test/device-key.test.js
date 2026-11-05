const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sodium = require('libsodium-wrappers-sumo');
const { wrapAccountKey, unwrapAccountKey } = require('../src/device-key');
const { Connector } = require('../src/connector');

test('account key round-trips from connector wrap to phone unwrap', async () => {
  await sodium.ready;
  const accountKey = crypto.randomBytes(32);
  const phone = sodium.crypto_box_keypair();
  const phonePublicB64 = Buffer.from(phone.publicKey).toString('base64');
  const envelope = wrapAccountKey(accountKey, phonePublicB64, 'acc-1', 'phone-1');

  assert.equal(envelope.version, 3);
  // The envelope must not contain the plaintext account key.
  assert.ok(!JSON.stringify(envelope).includes(accountKey.toString('base64')));

  const recovered = unwrapAccountKey(envelope, phone.privateKey, 'acc-1', 'phone-1');
  assert.deepEqual(recovered, accountKey);
});

test('an envelope cannot be opened for a different account or device (AAD binding)', async () => {
  await sodium.ready;
  const accountKey = crypto.randomBytes(32);
  const phone = sodium.crypto_box_keypair();
  const envelope = wrapAccountKey(accountKey, Buffer.from(phone.publicKey).toString('base64'), 'acc-1', 'phone-1');
  assert.throws(() => unwrapAccountKey(envelope, phone.privateKey, 'acc-2', 'phone-1'));
  assert.throws(() => unwrapAccountKey(envelope, phone.privateKey, 'acc-1', 'phone-9'));
});

test('another phone key cannot open the envelope', async () => {
  await sodium.ready;
  const accountKey = crypto.randomBytes(32);
  const phone = sodium.crypto_box_keypair();
  const attacker = sodium.crypto_box_keypair();
  const envelope = wrapAccountKey(accountKey, Buffer.from(phone.publicKey).toString('base64'), 'acc-1', 'phone-1');
  assert.throws(() => unwrapAccountKey(envelope, attacker.privateKey, 'acc-1', 'phone-1'));
});

test('rejects a malformed phone public key', async () => {
  await sodium.ready;
  assert.throws(() => wrapAccountKey(crypto.randomBytes(32), Buffer.alloc(16).toString('base64'), 'a', 'd'), /32 bytes/);
});

test('provisionPhoneKeys wraps each pending phone and posts its envelope', async () => {
  await sodium.ready;
  const accountKey = crypto.randomBytes(32);
  const phone = sodium.crypto_box_keypair();
  const phonePublicB64 = Buffer.from(phone.publicKey).toString('base64');

  const posted = [];
  const connector = Object.create(Connector.prototype);
  connector.stopping = false;
  connector.ws = { readyState: require('ws').OPEN };
  connector.config = { accountKey, accountId: 'acc-1' };
  connector.log = (e) => { throw e; };
  connector.api = {
    config: { accountId: 'acc-1' },
    path: (s) => `/api/v2${s}`,
    request: async (path, options) => {
      if (path.endsWith('/connector/devices/pending-keys')) {
        return { devices: [{ deviceId: 'phone-1', name: 'Test Phone', publicKey: phonePublicB64 }] };
      }
      if (path.endsWith('/connector/devices/key')) { posted.push(options.body); return { delivered: true }; }
      throw new Error(`unexpected path ${path}`);
    },
  };

  await connector.provisionPhoneKeys();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].deviceId, 'phone-1');
  const envelope = JSON.parse(posted[0].keyEnvelope);
  const recovered = unwrapAccountKey(envelope, phone.privateKey, 'acc-1', 'phone-1');
  assert.deepEqual(recovered, accountKey);
});

test('provisionPhoneKeys does nothing while offline or without an account key', async () => {
  const connector = Object.create(Connector.prototype);
  let called = false;
  connector.stopping = false;
  connector.config = { accountKey: Buffer.alloc(32) };
  connector.ws = { readyState: 0 }; // CONNECTING
  connector.api = { path: (s) => s, request: async () => { called = true; return {}; } };
  await connector.provisionPhoneKeys();
  connector.ws = { readyState: require('ws').OPEN };
  connector.config = { accountKey: '' };
  await connector.provisionPhoneKeys();
  assert.equal(called, false);
});
