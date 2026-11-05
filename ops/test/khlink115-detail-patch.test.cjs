'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { patchPreviewSource, patchHermesSource, ROUTE, LEGACY, HERMES_BUSY, FILE_ACTIONS, CAPABILITIES } = require('../khlink115-detail-patch.cjs');
const transfer = require('../../fengzhu-connect/src/light-detail-transfer');

function preview() {
  return `class Connector {
    async command(payload, sourceDeviceId = null) {
      const threadId = payload.args?.threadId;
${ROUTE}
      if (payload.action.startsWith('file.')) return this.executeCommand(payload);
      throw new Error('电脑上未找到 Codex CLI');
    }
    async executeCommand(payload) {
      const args = payload.args || {}; const action = payload.action;
${LEGACY}
${CAPABILITIES}
        return {};
      }
      if (this.codex?.ready === false) throw new Error('电脑上未找到 Codex CLI');
${FILE_ACTIONS}
      throw new Error('电脑上未找到 Codex CLI');
    }
  }
  globalThis.Connector = Connector;`;
}

function makeConnector(rows) {
  const source = patchPreviewSource(preview());
  const scope = { Buffer, require: (name) => {
    assert.equal(name, './light-detail-transfer');
    return transfer;
  } };
  vm.runInNewContext(source, scope);
  const connector = new scope.Connector();
  connector.lightMode = { details: (threadId, ids) => rows.filter((row) => row.threadId === threadId && ids.includes(row.id)) };
  connector.codex = { ready: false };
  return connector;
}

test('Linux Hermes history details bypass Codex and return every encrypted chunk', async () => {
  const ciphertext = 'x'.repeat(transfer.DETAIL_CHUNK_CHARS + 101);
  const connector = makeConnector([{ threadId: 'hermes-test', id: 'row', nonce: 'nonce', ciphertext }]);
  const args = { threadId: 'hermes-test', id: 'row' };
  const first = await connector.command({ action: 'file.historyDetailPart', args });
  assert.equal(first.found, true);
  assert.equal(first.eof, false);
  const second = await connector.command({ action: 'file.historyDetailPart', args: { ...args, offset: first.chunk.length, transferId: first.transferId } });
  assert.equal(second.eof, true);
  assert.equal(first.chunk + second.chunk, ciphertext);
  assert.equal(first.nonce, 'nonce');
  const legacy = await connector.command({ action: 'history.details', args: { threadId: args.threadId, ids: ['row'] } });
  assert.equal(legacy.items.length, 1);
  await assert.rejects(connector.command({ action: 'turn.start', args }), /未找到 Codex CLI/);
});

test('Linux history detail search handles missing rows and rejects unrelated or oversized transfers', async () => {
  const connector = makeConnector([{ threadId: 'hermes-a', id: 'big', nonce: 'n', ciphertext: 'x'.repeat(transfer.LEGACY_DETAIL_JSON_BYTES + 1) }]);
  const missing = await connector.command({ action: 'file.historyDetailPart', args: { threadId: 'hermes-b', id: 'big' } });
  assert.equal(missing.found, false);
  await assert.rejects(connector.command({ action: 'history.details', args: { threadId: 'hermes-a', ids: ['big'] } }), /请更新手机端/);
});

test('Linux preview patch refuses changed or ambiguous source anchors', () => {
  assert.throws(() => patchPreviewSource('changed'), /differs/);
  assert.throws(() => patchPreviewSource(preview() + ROUTE), /differs/);
  assert.throws(() => patchPreviewSource(preview() + LEGACY), /differs/);
  assert.throws(() => patchHermesSource('changed'), /differs/);
  assert.throws(() => patchHermesSource(HERMES_BUSY + HERMES_BUSY), /differs/);
});

test('Linux uploads and file reads work with Codex absent', async () => {
  const connector = makeConnector([]);
  for (const [action, method] of [['file.read', 'readFile'], ['file.upload.begin', 'beginUpload'],
    ['file.upload.chunk', 'writeUpload'], ['file.upload.finish', 'finishUpload'], ['file.upload.abort', 'abortUpload']]) {
    connector[method] = (args) => ({ observed: action, args });
    const value = await connector.command({ action, args: { threadId: 'hermes-test' } });
    assert.equal(value.observed, action);
  }
});

test('the patch preserves the CRLF line endings of the deployed Linux preview', () => {
  const original = preview().replace(/\n/g, '\r\n');
  const patched = patchPreviewSource(original);
  assert.match(patched, /file\.historyDetailPart/);
  assert.equal(patched.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(patchHermesSource(HERMES_BUSY.replace(/\n/g, '\r\n')), /sendRunningImage/);
});
