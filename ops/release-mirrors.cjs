'use strict';

// The CDN currently serves individual GitHub files up to 20 MiB. Keep the
// relay's `url` as the final source for old clients and for blocked mirrors.
const MAX_CDN_BYTES = 20 * 1024 * 1024;
const CDN_HOSTS = ['gcore.jsdelivr.net', 'fastly.jsdelivr.net', 'cdn.jsdelivr.net'];
const ASSET_NAMES = {
  android: entry => `khLink-android-${entry.versionName}.apk`,
  windowsConnector: entry => `khLink-connector-${entry.version}.tgz`,
  windowsDesktop: entry => `khLink-windows-${entry.version}-x64-setup.exe`,
};

function validatePart(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function planManifest(input, { repo, tag, fileSize }) {
  validatePart(repo, /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'release repository');
  validatePart(tag, /^[A-Za-z0-9_.-]+$/, 'release tag');
  const manifest = JSON.parse(JSON.stringify(input));
  const assets = [];
  for (const [kind, assetName] of Object.entries(ASSET_NAMES)) {
    const entry = manifest[kind];
    if (!entry?.url) continue;
    const relay = new URL(entry.url);
    if (relay.protocol !== 'https:' || relay.username || relay.password) throw new Error(`Invalid ${kind} fallback`);
    const local = decodeURIComponent(relay.pathname.split('/').pop());
    validatePart(local, /^[A-Za-z0-9_.-]+$/, 'local asset name');
    const asset = validatePart(assetName(entry), /^[A-Za-z0-9_.-]+$/, 'public asset name');
    const size = fileSize(local);
    // This run did not rebuild the package (a rebuilt entry is written without
    // `urls`) and an earlier release already holds it under the same name:
    // keep those links instead of uploading it again (the 41 MB desktop
    // installer went up with every phone-only release, 2026-11-05).
    const released = Array.isArray(entry.urls) && entry.urls.some(url => typeof url === 'string'
      && url.startsWith(`https://github.com/${repo}/releases/download/`) && url.endsWith(`/${asset}`));
    if (Number.isSafeInteger(size) && size > 0 && !released) {
      const github = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
      const cdn = size <= MAX_CDN_BYTES ? CDN_HOSTS.map(host => `https://${host}/gh/${repo}@${tag}-dist/${asset}`) : [];
      // On the test phone GitHub release assets time out while Gcore serves
      // the full APK. Prefer Gcore for small files, then GitHub and other CDNs.
      entry.urls = cdn.length ? [cdn[0], github, ...cdn.slice(1), relay.href] : [github, relay.href];
      assets.push({ local, asset, size });
    } else {
      // A release may update just one component. Keep working public URLs
      // for unchanged components; discard links to the former private repo.
      const github = `https://github.com/${repo}/releases/download/`;
      const cdn = CDN_HOSTS.map(host => `https://${host}/gh/${repo}@`);
      const prior = Array.isArray(entry.urls) ? entry.urls : [];
      entry.urls = [...new Set([...prior.filter(url => typeof url === 'string' &&
        (url.startsWith(github) || cdn.some(prefix => url.startsWith(prefix)))), relay.href])];
    }
  }
  return { manifest, assets };
}

function verifyReleaseAssets(response, stage, fs, crypto) {
  const uploaded = new Map((response.assets || []).map(asset => [asset.name, asset.digest]));
  const required = fs.readdirSync(stage).filter(name => /^khLink-.*\.(apk|exe|tgz)$/.test(name))
    .concat(['update-manifest.json', 'update-manifest.sig', 'SHA256SUMS.txt']);
  if (!required.some(name => /^khLink-/.test(name))) throw new Error('No release package to verify');
  for (const name of required) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(require('node:path').join(stage, name))).digest('hex');
    if (uploaded.get(name) !== `sha256:${hash}`) throw new Error(`GitHub asset digest differs: ${name}`);
  }
  return required.length;
}

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const [manifestFile, repo, tag] = args;
    const input = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const plan = planManifest(input, { repo, tag, fileSize: name => {
      try { return fs.statSync(path.join(path.dirname(manifestFile), name)).size; } catch { return null; }
    } });
    fs.writeFileSync(manifestFile, `${JSON.stringify(plan.manifest, null, 2)}\n`);
    for (const { local, asset } of plan.assets) console.log(`${local}|${asset}`);
  } else if (command === 'verify') {
    const [responseFile, stage] = args;
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
    console.log(`GitHub asset digests verified: ${verifyReleaseAssets(response, stage, fs, require('node:crypto'))}`);
  } else {
    throw new Error('Expected plan or verify');
  }
}

module.exports = { MAX_CDN_BYTES, CDN_HOSTS, planManifest, verifyReleaseAssets };
