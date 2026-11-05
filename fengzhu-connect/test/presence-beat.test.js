const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector, presenceSignature, PRESENCE_FULL_MS } = require('../src/connector');

function connectorWith(state) {
  const connector = Object.create(Connector.prototype);
  const sent = [];
  connector.presencePayload = (sentAt) => ({ deviceName: 'PC', connectorId: 'pc-1', sentAt, pcLoad: { cpu: state.cpu, at: sentAt },
    agents: { claude: true }, activeThreads: state.active, threadOwners: state.owners });
  connector.emit = (kind, _threadId, payload) => sent.push([kind, payload]);
  return { connector, sent };
}

test('the whole presence goes out once, then only small beats until something changes', () => {
  const state = { cpu: 10, active: [{ threadId: 't1', status: 'desktop_running', updatedAt: 1 }], owners: [{ threadId: 't1', owner: 'desktop' }] };
  const { connector, sent } = connectorWith(state);
  assert.equal(connector.publishPresence({ sentAt: 1000 }), true);
  assert.ok(sent[0][1].threadOwners);
  // The load and a running turn's event time move every second: still a beat.
  state.cpu = 55; state.active = [{ threadId: 't1', status: 'desktop_running', updatedAt: 2 }];
  assert.equal(connector.publishPresence({ sentAt: 2000 }), false);
  assert.deepEqual(sent[1], ['connector.presence', { deviceName: 'PC', connectorId: 'pc-1', sentAt: 2000, pcLoad: { cpu: 55, at: 2000 } }]);
  assert.ok(JSON.stringify(sent[1][1]).length < 200);
  // A turn finishing changes what the phone must know.
  state.active = [];
  assert.equal(connector.publishPresence({ sentAt: 3000 }), true);
  assert.deepEqual(sent[2][1].activeThreads, []);
});

test('a phone asking for capabilities and the periodic refresh get the whole presence', () => {
  const state = { cpu: 1, active: [], owners: [] };
  const { connector } = connectorWith(state);
  connector.publishPresence({ sentAt: 1000 });
  assert.equal(connector.publishPresence({ sentAt: 2000 }), false);
  connector.presenceFullDue = true;
  assert.equal(connector.publishPresence({ sentAt: 3000 }), true);
  assert.equal(connector.publishPresence({ sentAt: 4000 }), false);
  assert.equal(connector.publishPresence({ sentAt: 3000 + PRESENCE_FULL_MS }), true);
  assert.equal(connector.publishPresence({ sentAt: 5000 + PRESENCE_FULL_MS, full: true }), true);
});

test('the signature ignores time, load and observation times but not statuses', () => {
  const base = { deviceName: 'PC', sentAt: 1, pcLoad: { cpu: 1 }, activeThreads: [{ threadId: 'a', status: 'desktop_running', updatedAt: 1 }] };
  assert.equal(presenceSignature(base), presenceSignature({ ...base, sentAt: 9, pcLoad: { cpu: 80 }, activeThreads: [{ threadId: 'a', status: 'desktop_running', updatedAt: 9 }] }));
  assert.notEqual(presenceSignature(base), presenceSignature({ ...base, activeThreads: [{ threadId: 'a', status: 'desktop_waiting', updatedAt: 1 }] }));
});
