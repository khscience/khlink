const test = require('node:test');
const assert = require('node:assert/strict');
const { planManifest, verifyReleaseAssets, MAX_CDN_BYTES } = require('../release-mirrors.cjs');
const crypto = require('node:crypto');

const repo = 'owner/public-releases';
const tag = 'v2026.11.01.1';
const relay = 'https://example.org/downloads';
function input() {
  return {
    android: { versionName: '0.1.298', url: `${relay}/old.apk`, urls: ['https://github.com/owner/private/releases/old'] },
    windowsConnector: { version: '0.2.112', url: `${relay}/connector.tgz` },
    windowsDesktop: { version: '0.1.27', url: `${relay}/desktop.exe` },
  };
}
test('small APK and connector receive independent CDN routes before the relay', () => {
  const { manifest, assets } = planManifest(input(), { repo, tag, fileSize: name => name.endsWith('.exe') ? MAX_CDN_BYTES + 1 : 1024 });
  assert.equal(assets.length, 3);
  for (const entry of [manifest.android, manifest.windowsConnector]) {
    assert.match(entry.urls[0], /^https:\/\/gcore\.jsdelivr\.net\//);
    assert.match(entry.urls[1], /^https:\/\/github\.com\/owner\/public-releases\/releases\/download\//);
    assert.match(entry.urls[2], /^https:\/\/fastly\.jsdelivr\.net\//);
    assert.match(entry.urls[3], /^https:\/\/cdn\.jsdelivr\.net\//);
    assert.equal(entry.urls[4], entry.url);
  }
  assert.equal(manifest.windowsDesktop.urls.length, 2);
  assert.equal(manifest.windowsDesktop.urls[1], manifest.windowsDesktop.url);
});
test('unchanged releases retain working public sources and drop private or malformed links', () => {
  const before = input();
  const publicUrl = `https://github.com/${repo}/releases/download/older/a.apk`;
  const cdn = `https://gcore.jsdelivr.net/gh/${repo}@older-dist/a.apk`;
  before.android.urls = [publicUrl, cdn, publicUrl, 'https://github.com/owner/private/releases/a', 'http://evil.test/a'];
  const { manifest, assets } = planManifest(before, { repo, tag, fileSize: () => null });
  assert.deepEqual(manifest.android.urls, [publicUrl, cdn, before.android.url]);
  assert.deepEqual(manifest.windowsConnector.urls, [before.windowsConnector.url]);
  assert.equal(assets.length, 0);
  assert.equal(before.android.urls.length, 5);
});
test('a package an earlier release already holds is not uploaded again', () => {
  const before = input();
  const exe = `https://github.com/${repo}/releases/download/older/khLink-windows-0.1.27-x64-setup.exe`;
  before.windowsDesktop.urls = [exe, before.windowsDesktop.url];
  // A different file name in an older release (the previous APK) does not count.
  before.android.urls = [`https://github.com/${repo}/releases/download/older/khLink-android-0.1.297.apk`];
  const { manifest, assets } = planManifest(before, { repo, tag, fileSize: () => 1024 });
  assert.deepEqual(assets.map(a => a.asset).sort(), ['khLink-android-0.1.298.apk', 'khLink-connector-0.2.112.tgz']);
  assert.deepEqual(manifest.windowsDesktop.urls, [exe, before.windowsDesktop.url]);
  assert.match(manifest.android.urls[1], /releases\/download\/v2026\.11\.01\.1\/khLink-android-0\.1\.298\.apk$/);
});
test('rejects malformed repository, tag and fallback URL', () => {
  assert.throws(() => planManifest(input(), { repo: '../bad', tag, fileSize: () => 1 }));
  assert.throws(() => planManifest(input(), { repo, tag: '../bad', fileSize: () => 1 }));
  const bad = input(); bad.android.url = 'https://user:password@example.org/file.apk';
  assert.throws(() => planManifest(bad, { repo, tag, fileSize: () => 1 }));
});

test('verifies every uploaded asset digest and rejects missing or altered packages', () => {
  const files = ['khLink-android-1.apk', 'update-manifest.json', 'update-manifest.sig', 'SHA256SUMS.txt'];
  const fs = { readdirSync: () => files, readFileSync: name => Buffer.from(require('node:path').basename(name)) };
  const assets = files.map(name => ({ name, digest: 'sha256:' + crypto.createHash('sha256').update(name).digest('hex') }));
  assert.equal(verifyReleaseAssets({ assets }, 'stage', fs, crypto), 4);
  assert.throws(() => verifyReleaseAssets({ assets: assets.slice(1) }, 'stage', fs, crypto), /digest differs/);
  assets[0].digest = 'sha256:' + '0'.repeat(64);
  assert.throws(() => verifyReleaseAssets({ assets }, 'stage', fs, crypto), /digest differs/);
  assert.throws(() => verifyReleaseAssets({ assets: [] }, 'stage', { ...fs, readdirSync: () => [] }, crypto), /No release package/);
});
