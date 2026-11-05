'use strict';
const { Profiles } = require('./profiles.cjs');
const { readAccount } = require('./rpc.cjs');
async function main(args, store = new Profiles(), reader = readAccount) {
  const [action, id, value] = args;
  if (action === 'state') return store.state();
  if (action === 'create') return store.create(id);
  if (action === 'rename') { store.rename(id, value); return store.state(); }
  if (action === 'remove' || action === 'restore') { store[action](id); return store.state(); }
  if (action === 'select') { store.select(id); return store.state(); }
  if (action === 'profile') return store.profile(id);
  if (action === 'refresh') {
    const profile = store.profile(id), old = store.records()[id];
    // Poll only the selected account, at most once a minute. A UI refresh never
    // means logging in, logging out, sending a prompt or changing an account.
    if (args[3] !== 'force' && old?.checkedAt && Date.now() - old.checkedAt < 60000) return store.state();
    let record;
    try {
      record = await reader(value, profile, { includeIdentity: true });
      if (record.error && old?.usage && record.fingerprint && record.fingerprint === old.fingerprint && record.loggedIn && old.loggedIn) record.usage = old.usage;
    } catch { record = { ...(old || { usage: null }), loggedIn: null, checkedAt: Date.now(), error: '暂时无法读取，请稍后更新记录。' }; }
    store.saveRecord(id, record); return store.state();
  }
  throw new Error('不支持的本地账号操作。');
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then(v => console.log(JSON.stringify(v))).catch(e => { console.error(e.code ? '本地账号目录暂时不可用。' : e.message); process.exitCode = 1; });
