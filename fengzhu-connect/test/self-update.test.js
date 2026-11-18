const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { newer, verifyManifest, fetchManifest, downloadUrls, restartBlocker, stageUpdate } = require('../src/self-update');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const sign = (manifest) => crypto.sign(null, Buffer.from(manifest), privateKey);

function manifestFor(version, pkg) {
  const sha256 = crypto.createHash('sha256').update(pkg).digest('hex');
  return JSON.stringify({ windowsConnector: { version, sha256, url: `https://relay/fengzhu-connect-${version}.tgz`, urls: [`https://cdn/khLink-connector-${version}.tgz`] } });
}

// Sources keyed by base URL: { manifest, sig } or an Error; files keyed by URL.
function fakeFetch(files) {
  return async (url) => {
    const body = files[url];
    if (body === undefined || body instanceof Error) throw body || new Error(`no ${url}`);
    const bytes = Buffer.from(body);
    return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes };
  };
}

function served(base, manifest, sigEncoding = 'raw') {
  const sig = sign(manifest);
  return { [`${base}/update-manifest.json`]: manifest, [`${base}/update-manifest.sig`]: sigEncoding === 'raw' ? sig : sig.toString('base64') };
}

test('version comparison', () => {
  assert.equal(newer('0.2.166', '0.2.165'), true);
  assert.equal(newer('0.2.92', '0.2.9'), true);
  assert.equal(newer('0.2.165', '0.2.165'), false);
  assert.equal(newer('0.2', '0.2.0'), false);
  assert.equal(newer('', '0.2.1'), false);
});

test('manifest signature: raw or Base64, and a tampered manifest is refused', () => {
  const manifest = Buffer.from('{"windowsConnector":{"version":"1.0.0"}}');
  const sig = sign(manifest);
  assert.equal(verifyManifest(manifest, sig, pem).windowsConnector.version, '1.0.0');
  assert.equal(verifyManifest(manifest, Buffer.from(sig.toString('base64')), pem).windowsConnector.version, '1.0.0');
  assert.throws(() => verifyManifest(Buffer.from('{"windowsConnector":{"version":"9.9.9"}}'), sig, pem), /签名验证失败/);
});

test('the newest verified manifest wins; a lagging CDN or a bad signature does not', async () => {
  const pkg = Buffer.from('pkg');
  const files = {
    ...served('https://a', manifestFor('0.2.163', pkg)),
    ...served('https://b', manifestFor('0.2.166', pkg), 'base64'),
    'https://c/update-manifest.json': manifestFor('0.2.999', pkg),
    'https://c/update-manifest.sig': sign(manifestFor('0.2.1', pkg)),
  };
  const manifest = await fetchManifest({ sources: ['https://a', 'https://b', 'https://c', 'https://down'], publicKey: pem, fetchFn: fakeFetch(files) });
  assert.equal(manifest.windowsConnector.version, '0.2.166');
  await assert.rejects(fetchManifest({ sources: ['https://c'], publicKey: pem, fetchFn: fakeFetch(files) }), /更新清单读取失败/);
});

test('download sources: urls first, then url, https only, no repeats', () => {
  assert.deepEqual(downloadUrls({ urls: ['https://x', 'http://plain', 'https://x'], url: 'https://y' }), ['https://x', 'https://y']);
});

test('restart blocker reads only a fresh status', () => {
  const now = 1_000_000;
  assert.equal(restartBlocker({ updatedAt: now, restartSafe: true, inFlightCommands: 0 }, now), null);
  assert.match(restartBlocker({ updatedAt: now, restartSafe: false }, now), /还有任务/);
  assert.match(restartBlocker({ updatedAt: now, inFlightCommands: 2 }, now), /还有任务/);
  assert.equal(restartBlocker({ updatedAt: now - 60_000, restartSafe: false }, now), null);
  assert.equal(restartBlocker(null, now), null);
});

function setup(installedVersion, deps = { ws: '^8' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-update-'));
  const appDir = path.join(root, 'app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: installedVersion, dependencies: deps }));
  return { root, appDir, workDir: path.join(root, 'update'), statusFile: path.join(root, 'status.json') };
}

// Stand-in for tar: the "archive" is the JSON of the package to unpack.
function fakeExtract(complete = true) {
  return (archive, into) => {
    const pkg = JSON.parse(fs.readFileSync(archive, 'utf8'));
    fs.mkdirSync(path.join(into, 'src'), { recursive: true });
    fs.mkdirSync(path.join(into, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(into, 'package.json'), JSON.stringify(pkg));
    if (complete) fs.writeFileSync(path.join(into, 'src', 'cli.js'), '');
    fs.writeFileSync(path.join(into, 'scripts', 'khlink-macos.sh'), '');
  };
}

function relayFor(version, deps = { ws: '^8' }, corrupt = false) {
  const pkg = Buffer.from(JSON.stringify({ version, dependencies: deps }));
  const manifest = manifestFor(version, pkg);
  return { ...served('https://relay', manifest), [`https://cdn/khLink-connector-${version}.tgz`]: new Error('cdn down'),
    [`https://relay/fengzhu-connect-${version}.tgz`]: corrupt ? Buffer.from('other') : pkg };
}

test('up to date: nothing is downloaded', async () => {
  const dirs = setup('0.2.166');
  const result = await stageUpdate({ ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166')), extract: fakeExtract() });
  assert.deepEqual(result, { available: false, installed: '0.2.166', latest: '0.2.166' });
  assert.equal(fs.existsSync(dirs.workDir), false);
});

test('a newer version is verified and unpacked, falling back to the next source', async () => {
  const dirs = setup('0.2.165');
  const result = await stageUpdate({ ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166')), extract: fakeExtract() });
  assert.equal(result.available, true);
  assert.equal(result.version, '0.2.166');
  assert.equal(result.depsChanged, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.staged, 'package.json'), 'utf8')).version, '0.2.166');
  assert.deepEqual(fs.readdirSync(dirs.workDir), ['staged-0.2.166'], 'the archive is removed');
});

test('changed dependencies are reported so the script reinstalls them', async () => {
  const dirs = setup('0.2.165');
  const result = await stageUpdate({ ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166', { ws: '^9' })), extract: fakeExtract() });
  assert.equal(result.depsChanged, true);
});

test('a package that does not match its hash, or is incomplete, is refused', async () => {
  const dirs = setup('0.2.165');
  await assert.rejects(stageUpdate({ ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166', undefined, true)), extract: fakeExtract() }), /校验失败/);
  await assert.rejects(stageUpdate({ ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166')), extract: fakeExtract(false) }), /不完整/);
  assert.equal(fs.existsSync(path.join(dirs.workDir, 'staged-0.2.166')), false);
});

test('a busy connector waits for the next check unless forced', async () => {
  const dirs = setup('0.2.165');
  fs.writeFileSync(dirs.statusFile, JSON.stringify({ updatedAt: Date.now(), restartSafe: false }));
  const options = { ...dirs, sources: ['https://relay'], publicKey: pem, fetchFn: fakeFetch(relayFor('0.2.166')), extract: fakeExtract() };
  const waiting = await stageUpdate(options);
  assert.match(waiting.busy, /还有任务/);
  assert.equal(waiting.staged, undefined);
  assert.equal((await stageUpdate({ ...options, force: true })).version, '0.2.166');
});

test('the embedded key is the release signing key', () => {
  const body = fs.readFileSync(path.join(__dirname, '..', '..', 'releases', 'update-signing-public.pem'), 'utf8').split(/\r?\n/)[1].trim();
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'self-update.js'), 'utf8').includes(body));
});
