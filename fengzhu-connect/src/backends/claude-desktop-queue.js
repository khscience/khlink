'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const fingerprint = value => crypto.createHash('sha256').update(String(value || '').trim()).digest('hex');

// A dequeue has no message id. Old harness notifications can leave its FIFO
// out of alignment, so a later real user record is also evidence of receipt.
// Keep dequeue receipts across incremental reads: consuming that user record
// must not remove a second identical message that is still waiting.
function reduceQueue(previous, operations, previousReceipts = []) {
  const queue = previous.map(item => ({ ...item }));
  const receipts = previousReceipts.map(item => ({ ...item }));
  const received = (item, at) => { if (item) receipts.push({ hash: fingerprint(item.text), at }); };
  for (const op of operations) {
    if (op.op === 'enqueue') {
      if (!op.content || /^\s*</.test(op.content)) queue.push({ internal: true, text: op.content, createdAt: op.at });
      else queue.push({ id: `dq-${crypto.createHash('sha1').update(`${op.at}|${op.content}`).digest('hex').slice(0, 16)}`,
        text: op.content, createdAt: op.at, state: 'desktop_queued', origin: 'desktop', blocking: true, backend: 'claude' });
    } else if (op.op === 'dequeue') received(queue.shift(), op.at);
    else if (op.op === 'remove') {
      const index = queue.findIndex(item => item.text === op.content);
      if (index >= 0) received(queue.splice(index, 1)[0], op.at);
    } else if (op.op === 'received') {
      const hash = fingerprint(op.content);
      const receipt = receipts.findIndex(item => item.hash === hash && item.at <= op.at);
      if (receipt >= 0) receipts.splice(receipt, 1);
      else {
        const index = queue.findIndex(item => fingerprint(item.text) === hash && (item.createdAt || 0) <= op.at);
        if (index >= 0) queue.splice(index, 1);
      }
    }
    if (receipts.length > 50) receipts.splice(0, receipts.length - 50);
  }
  return { queue, receipts };
}

// One-time repair of a nonempty legacy queue; reads bounded chunks and never
// constructs or uploads historical conversation items. mtime is irrelevant.
function readQueue(file, userText, maxBytes = Infinity) {
  const fd = fs.openSync(file, 'r'), decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(1024 * 1024);
  let pending = '', remaining = maxBytes, state = { queue: [], receipts: [] };
  try {
    let count;
    while (remaining > 0 && (count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null))) {
      remaining -= count;
      pending += decoder.write(buffer.subarray(0, count));
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let row; try { row = JSON.parse(line); } catch { continue; }
        const at = Date.parse(row.timestamp); if (!Number.isFinite(at)) continue;
        let operation;
        if (row.type === 'queue-operation') operation = { op: row.operation, content: typeof row.content === 'string' ? row.content : '', at };
        else if (row.type === 'user' && !row.isSidechain && !row.isMeta) {
          const content = userText(row.message?.content).trim();
          if (content && !/^\[Request interrupted/.test(content)) operation = { op: 'received', content, at };
        }
        if (operation) state = reduceQueue(state.queue, [operation], state.receipts);
      }
      if (pending.length > 64 * 1024 * 1024) throw new Error('Claude queue record is too large');
    }
    // The writer may still own an incomplete last line; leave it for the
    // normal transcript offset reader rather than treating it as a receipt.
    return state;
  } finally { fs.closeSync(fd); }
}
module.exports = { reduceQueue, readQueue };
