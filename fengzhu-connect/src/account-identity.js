'use strict';
// KH Link's own random installation key, never an Agent login credential.
// It prevents cross-installation correlation and dictionary attacks on IDs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let cached;
function identityKey(file) {
  const dir = file ? path.dirname(file) : process.platform === 'win32' && fs.existsSync('G:\\')
    ? 'G:\\Apps\\KHLink\\identity' : path.join(process.env.APPDATA || os.homedir(), 'KHLink', 'identity');
  file ||= path.join(dir, 'installation.key');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw new Error('本机匿名标识暂时不可用。'); }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== 32) throw new Error('本机匿名标识无效。');
  return fs.readFileSync(file);
}
function accountIdentity(namespace, identity, key) {
  if (!identity) return null;
  key ||= cached ||= identityKey();
  return crypto.createHmac('sha256', key).update(namespace).update('\0').update(String(identity)).digest('hex').slice(0, 32);
}
module.exports = { accountIdentity, identityKey };
