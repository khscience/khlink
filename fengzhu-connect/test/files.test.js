const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { validateLocalPath, list, isSecretPath, assertReadable } = require('../src/files');
const { Connector } = require('../src/connector');

test('file reads fail closed if a real path cannot be resolved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-realpath-failure-'));
  const protectedDir = path.join(root, '.ssh'); fs.mkdirSync(protectedDir);
  fs.writeFileSync(path.join(protectedDir, 'sample.txt'), 'synthetic test data');
  const alias = path.join(root, 'ordinary');
  fs.symlinkSync(protectedDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(alias, 'sample.txt');
  const native = fs.realpathSync.native;
  try {
    fs.realpathSync.native = () => { throw Object.assign(new Error('simulated resolution failure'), { code: 'EIO' }); };
    assert.throws(() => assertReadable(validateLocalPath(file)), /无法确认文件的真实路径/);
  } finally {
    fs.realpathSync.native = native;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the phone cannot read credential and key files, but ordinary files stay readable', () => {
  for (const blocked of [
    'G:\\CodexData\\.codex\\auth.json',
    'C:\\Users\\me\\.ssh\\id_ed25519',
    'C:\\Users\\me\\.ssh\\config',
    'D:\\work\\khlink\\.secrets\\android-signing.json',
    'D:\\work\\khlink\\.secrets\\fengzhu-bridge-release.jks',
    'C:\\Users\\me\\AppData\\Roaming\\FengzhuAgentBridge\\config.json',
    'G:\\Apps\\pi-agent\\.pi\\agent\\models.json',
    'I:\\qmt5\\code\\.env',
    'I:\\qmt5\\code\\.env.local',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies',
    'C:\\Users\\me\\AppData\\Roaming\\Claude\\config.json',
    'C:\\Users\\me\\.claude\\.credentials.json',
    'C:\\keys\\server.pem',
  ]) assert.equal(isSecretPath(blocked), true, blocked);
  for (const allowed of [
    'I:\\qmt5\\code\\main.py',
    'I:\\qmt5\\code\\README.md',
    'I:\\qmt5\\code\\environment.yml',
    'C:\\Users\\me\\AppData\\Roaming\\FengzhuAgentBridge\\logs\\connector-2026-09-28.log',
  ]) assert.equal(isSecretPath(allowed), false, allowed);
});

test('more secret files and areas are refused', () => {
  for (const blocked of [
    'C:\\Users\\me\\.claude.json',
    'C:\\Users\\me\\.claude.json.backup',
    'C:\\Users\\me\\.codex\\config.toml',
    'C:\\Users\\me\\.config\\gh\\hosts.yml',
    'C:\\Users\\me\\.cc-switch\\config.json',
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\ABCDEF',
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-21\\key',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Credentials\\ABCDEF',
    'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\config.json',
    'I:\\project\\gcp-credentials.json',
    'I:\\project\\secrets.yaml',
  ]) assert.equal(isSecretPath(blocked), true, blocked);
  for (const allowed of [
    'C:\\Users\\me\\.codex\\sessions\\2026\\09\\30\\rollout.jsonl',
    'C:\\Users\\me\\.claude\\projects\\x\\a.jsonl',
    'I:\\project\\config.toml',
  ]) assert.equal(isSecretPath(allowed), false, allowed);
});

test('Windows aliases of a file cannot get around the name checks', { skip: process.platform !== 'win32' }, () => {
  for (const alias of [
    'C:\\Users\\me\\.codex\\auth.json::$DATA',
    'C:\\Users\\me\\.codex\\auth.json:stream',
    'C:\\Users\\me\\.codex\\auth.json.',
    'C:\\Users\\me\\.codex\\auth.json ',
    'C:\\Users\\me\\.codex.\\auth.json',
  ]) assert.throws(() => validateLocalPath(alias), undefined, alias);
  assert.doesNotThrow(() => validateLocalPath('C:\\Users\\me\\..\\KH\\.\\note.txt'));

  // A real 8.3 short name: the long name is secret, the short one is not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-8dot3-'));
  const secretDir = path.join(dir, '.claude'); fs.mkdirSync(secretDir);
  const file = path.join(secretDir, '.credentials.json'); fs.writeFileSync(file, '{}');
  try {
    const short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${file}').ShortPath`], { encoding: 'utf8', windowsHide: true }).trim();
    if (short.toLowerCase() === file.toLowerCase()) return; // 8.3 names are off on this volume
    assert.equal(isSecretPath(validateLocalPath(short)), false, 'the short spelling alone looks harmless');
    assert.throws(() => assertReadable(validateLocalPath(short)), /密钥或登录凭据/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file browser rejects UNC and raw device paths',{ skip: process.platform !== 'win32' }, () => {
  assert.throws(() => validateLocalPath('\\\\server\\share'));
  assert.throws(() => validateLocalPath('\\\\.\\PhysicalDrive0'));
  const drives = list('', 0, 10).items;
  assert.ok(Array.isArray(drives));
  assert.ok(drives.length > 0);
  assert.ok(drives.every((drive) => drive.directory === true));
});

test('upload is isolated, ordered, and resumable by offset', () => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  const registered = []; connector.attachmentStore = { register: (item) => { registered.push(item); return { id: item.id }; } };
  const started = connector.beginUpload({ threadId: 'test/thread', name: '../note.txt', mimeType: 'text/plain' });
  assert.throws(() => connector.writeUpload({ uploadId: started.uploadId, offset: 2, data: Buffer.from('x').toString('base64') }));
  const chunk = connector.writeUpload({ uploadId: started.uploadId, offset: 0, data: Buffer.from('hello').toString('base64') });
  assert.equal(chunk.offset, 5);
  const finished = connector.finishUpload({ uploadId: started.uploadId });
  assert.equal(fs.readFileSync(finished.path, 'utf8'), 'hello');
  assert.equal(finished.attachmentId, started.uploadId);
  assert.equal(registered[0].mimeType, 'text/plain');
  fs.unlinkSync(finished.path);
});

test('new phones can finish an upload using only its registered opaque id', (t) => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  let stored;
  connector.attachmentStore = {
    register: (item) => { stored = item; return { id: item.id }; },
    resolve: (id, threadId) => { assert.equal(id, stored.id); assert.equal(threadId, stored.threadId); return stored; },
  };
  const started = connector.beginUpload({ threadId: 'test-thread', name: 'opaque.txt', mimeType: 'text/plain' });
  const target = connector.uploads.get(started.uploadId).target;
  t.after(() => { try { fs.unlinkSync(target); } catch {} });
  connector.writeUpload({ uploadId: started.uploadId, offset: 0, data: Buffer.from('hello').toString('base64') });
  const result = connector.finishUpload({ uploadId: started.uploadId, omitLocalPath: true });
  assert.equal(Object.hasOwn(result, 'path'), false);
  assert.equal(result.attachmentId, started.uploadId);
  const [resolved] = connector.resolveAttachments('test-thread', [{ name: 'opaque.txt', attachmentId: result.attachmentId }]);
  assert.equal(fs.readFileSync(resolved.path, 'utf8'), 'hello');
});

test('pathless upload fails closed if an attachment cannot be registered', () => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  const started = connector.beginUpload({ threadId: 'test-thread', name: 'not-registered.txt' });
  const target = connector.uploads.get(started.uploadId).target;
  connector.writeUpload({ uploadId: started.uploadId, offset: 0, data: Buffer.from('hello').toString('base64') });
  assert.throws(() => connector.finishUpload({ uploadId: started.uploadId, omitLocalPath: true }), /无法安全登记/);
  assert.equal(fs.existsSync(target), false);
});

test('empty upload is rejected and removed', () => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  const started = connector.beginUpload({ threadId: 'test/thread', name: 'empty.png' });
  const target = connector.uploads.get(started.uploadId).target;
  assert.throws(() => connector.finishUpload({ uploadId: started.uploadId }), /empty/i);
  assert.equal(fs.existsSync(target), false);
});

test('aborting an upload closes and removes the partial file', () => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  const started = connector.beginUpload({ threadId: 'test/thread', name: 'partial.png' });
  const target = connector.uploads.get(started.uploadId).target;
  connector.writeUpload({ uploadId: started.uploadId, offset: 0, data: Buffer.from('partial').toString('base64') });
  const result = connector.abortUpload({ uploadId: started.uploadId });
  assert.equal(result.aborted, true);
  assert.equal(connector.uploads.has(started.uploadId), false);
  assert.equal(fs.existsSync(target), false);
});

test('caller-generated upload ids allow cleanup after a lost begin response', () => {
  const connector = Object.create(Connector.prototype); connector.uploads = new Map();
  const uploadId = '12345678-1234-4123-8123-123456789abc';
  const begun = connector.beginUpload({ uploadId, threadId: 'test/thread', name: 'phone.png', mimeType: 'image/png' });
  assert.equal(begun.uploadId, uploadId);
  assert.throws(() => connector.beginUpload({ uploadId, threadId: 'test/thread', name: 'phone.png' }), /already exists/i);
  const target = connector.uploads.get(uploadId).target;
  connector.abortUpload({ uploadId });
  assert.equal(fs.existsSync(target), false);
});

test('a junction is followed, and the file it really leads to decides', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'khlink-junction-'));
  const realSecret = path.join(dir, 'real', '.ssh'); fs.mkdirSync(realSecret, { recursive: true });
  fs.writeFileSync(path.join(realSecret, 'notes.txt'), 'x');
  const realPlain = path.join(dir, 'plain'); fs.mkdirSync(realPlain); fs.writeFileSync(path.join(realPlain, 'a.txt'), 'x');
  fs.symlinkSync(realSecret, path.join(dir, 'looks-harmless'), 'junction');
  fs.symlinkSync(realPlain, path.join(dir, 'moved'), 'junction');
  try {
    assert.throws(() => assertReadable(validateLocalPath(path.join(dir, 'looks-harmless', 'notes.txt'))), /密钥或登录凭据/);
    assert.equal(assertReadable(validateLocalPath(path.join(dir, 'moved', 'a.txt'))).toLowerCase(), path.join(realPlain, 'a.txt').toLowerCase());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
