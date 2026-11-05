#!/usr/bin/env node
// Choose conversations to clean up in the relay's history, with this
// computer's account key (the relay cannot read archive state or pins).
//
//   node scripts/history-prune-list.js --idle-days 30 --out prune.json
//
// Archived conversations are to be deleted whole; those with no activity for
// --idle-days are to be trimmed (items removed, conversation kept). Pinned
// ones and any that is running or waiting are kept. Writes {"accountId",
// "deleteThreadIds", "trimThreadIds", "summary"} (ids only, no titles or
// content) for fengzhu-server's prune-history.js, and prints counts per agent.
'use strict';
require('node:dns').setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const { loadConfig } = require('../src/config');
const { BridgeApi } = require('../src/api');
const { ready, decryptJson } = require('../src/crypto');

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const idleDays = Number(value('--idle-days', '30'));
const out = value('--out');

async function main() {
  if (!out || !(idleDays > 0)) throw new Error('usage: history-prune-list.js --idle-days 30 --out prune.json');
  await ready();
  const config = loadConfig();
  if (!config.accountKey || config.protocolVersion !== 2) throw new Error('this computer has no v2 account key');
  const api = new BridgeApi(config);
  const cutoff = Date.now() - idleDays * 86_400_000;
  const remove = []; const trim = []; const summary = {}; let seen = 0; let unreadable = 0;
  for (let before = null; ;) {
    const page = await api.request(api.path(`/history/threads?limit=100${before ? `&before=${before}` : ''}`));
    const rows = page.items || [];
    for (const row of rows) {
      seen += 1;
      let meta;
      try { meta = decryptJson(config.accountKey, { kind: 'history.thread', threadId: row.id, id: row.id, nonce: row.nonce, ciphertext: row.ciphertext }); } catch { unreadable += 1; continue; }
      const backend = meta.backend || 'codex';
      const activity = Math.max(Number(meta.activityAt) || 0, Number(meta.updatedAt) || 0);
      const busy = /running|waiting|inprogress|active/i.test(String(meta.status || '')) || meta.waiting;
      const reason = meta.pinned || busy ? null : (row.archived || meta.archived) ? 'archived' : activity && activity < cutoff ? 'idle' : null;
      const line = (summary[backend] ||= { seen: 0, archived: 0, idle: 0, kept: 0 });
      line.seen += 1;
      if (reason) { line[reason] += 1; (reason === 'archived' ? remove : trim).push(row.id); } else line.kept += 1;
    }
    if (rows.length < 100) break;
    before = rows[rows.length - 1].updatedAt;
  }
  fs.writeFileSync(out, JSON.stringify({ accountId: config.accountId, idleDays, createdAt: new Date().toISOString(), deleteThreadIds: remove, trimThreadIds: trim, summary }, null, 2) + '\n');
  console.log(`${seen} conversations on the relay: ${remove.length} to delete (archived), ${trim.length} to trim (idle)${unreadable ? `, ${unreadable} unreadable (kept)` : ''}`);
  for (const [backend, line] of Object.entries(summary)) console.log(`  ${backend}: ${line.archived} archived, ${line.idle} idle > ${idleDays} days, ${line.kept} kept`);
  console.log(`written ${out}`);
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
