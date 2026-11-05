'use strict';

// Compatibility update for the 115 Linux preview release. The production
// Linux preview has platform-specific changes and must not be overwritten by
// the general Windows connector package. Apply only to a copied, stopped
// release whose connector source is exactly the reviewed preview-v9 baseline.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREVIEW_V9_SHA256 = 'b1cb1d0a588fee6e2fb028c315442c67959de5d04798384037801a9667a29bc2';
const HERMES_V9_SHA256 = 'f8c1b36f5bdd806f678ee7ee2f90d5f274e169dca1bb6ec714bf9165c2f7e73d';
const ROUTE = "    if (payload.action === 'thread.usage.read') return this.readConversationUsage(threadId, sourceDeviceId, payload.args?.historyFrom);";
const LEGACY = `    if (action === 'history.details') {
      const ids = (Array.isArray(args.ids) ? args.ids : []).filter((id) => typeof id === 'string').slice(0, 200);
      return { threadId: args.threadId, items: this.lightMode.details(args.threadId, ids) };
    }`;
const HERMES_BUSY = `        if (busy) {
          // One ACP prompt at a time per session: a second message steers the`;
const FILE_ACTIONS = `    if (action === 'file.list') return files.list(args.path, Number(args.cursor) || 0, Math.min(args.limit || 100, 200));
    if (action === 'file.read') return this.readFile(args);
    if (action === 'file.upload.begin') return this.beginUpload(args);
    if (action === 'file.upload.chunk') return this.writeUpload(args);
    if (action === 'file.upload.finish') return this.finishUpload(args);
    if (action === 'file.upload.abort') return this.abortUpload(args);`;
const CAPABILITIES = "    if (action === 'backends.capabilities') {";

function replaceOnce(source, needle, replacement) {
  if (source.includes('\r\n')) {
    needle = needle.replace(/\r?\n/g, '\r\n');
    replacement = replacement.replace(/\r?\n/g, '\r\n');
  }
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) !== -1) throw new Error('Linux preview differs from the reviewed source');
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

function patchPreviewSource(source) {
  const route = `    // History detail reads are connector-owned for every agent.\n    if (payload.action === 'history.details' || payload.action === 'file.historyDetailPart') return this.executeCommand(payload);\n${ROUTE}`;
  const legacy = `    if (action === 'history.details') {
      const ids = (Array.isArray(args.ids) ? args.ids : []).filter((id) => typeof id === 'string').slice(0, 200);
      const result = { threadId: args.threadId, items: await this.lightMode.details(args.threadId, ids) };
      const { LEGACY_DETAIL_JSON_BYTES } = require('./light-detail-transfer');
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LEGACY_DETAIL_JSON_BYTES) throw new Error('详细过程较大，请更新手机端后再取回');
      return result;
    }
    if (action === 'file.historyDetailPart') {
      const { LightDetailTransfers } = require('./light-detail-transfer');
      this.lightDetailTransfers ||= new LightDetailTransfers((threadId, ids) => this.lightMode.details(threadId, ids));
      try { return await this.lightDetailTransfers.read(args); }
      catch (error) {
        if (error.code === 'LIGHT_DETAILS_RETRY' && args.resumeSearch === true) return { id: args.id, found: false, pending: true };
        throw error;
      }
    }`;
  const withDetails = replaceOnce(replaceOnce(source, ROUTE, route), LEGACY, legacy);
  const withoutFiles = replaceOnce(withDetails, FILE_ACTIONS, '');
  return replaceOnce(withoutFiles, CAPABILITIES,
    `    // Connector file operations do not require a Codex installation.\n${FILE_ACTIONS}\n${CAPABILITIES}`);
}

function patchHermesSource(source) {
  return replaceOnce(source, HERMES_BUSY, `        if (busy) {
          if (blocks.some((block) => block.type === 'image')) {
            const { sendRunningImage } = require('./hermes-running-image');
            const result = await sendRunningImage(this.hermesAcp, meta.sessionId, blocks, { action, mode: args.mode });
            this.nudgeHermes([800, 3000]);
            return result;
          }
          // One ACP prompt at a time per session: a second message steers the`);
}

function install(releaseDir, helperFile, imageHelperFile) {
  const live = '/opt/khlink115/current';
  if (fs.existsSync(live) && fs.realpathSync(releaseDir) === fs.realpathSync(live)) {
    throw new Error('Refusing to patch the live release; create a staged copy first');
  }
  const connector = path.join(releaseDir, 'src', 'connector.js');
  const helper = path.join(releaseDir, 'src', 'light-detail-transfer.js');
  const hermes = path.join(releaseDir, 'src', 'backends', 'hermes-sync.js');
  const imageHelper = path.join(releaseDir, 'src', 'backends', 'hermes-running-image.js');
  const source = fs.readFileSync(connector, 'utf8');
  const hermesSource = fs.readFileSync(hermes, 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const hermesHash = crypto.createHash('sha256').update(hermesSource).digest('hex');
  if (hash !== PREVIEW_V9_SHA256 || hermesHash !== HERMES_V9_SHA256) throw new Error('Refusing to patch an unreviewed Linux connector version');
  if (fs.existsSync(helper) || fs.existsSync(imageHelper)) throw new Error('The staged release already contains a helper implementation');
  const updated = patchPreviewSource(source);
  const updatedHermes = patchHermesSource(hermesSource);
  const transfer = fs.readFileSync(helperFile);
  const image = fs.readFileSync(imageHelperFile);
  fs.writeFileSync(`${connector}.tmp`, updated, { flag: 'wx' });
  fs.writeFileSync(`${helper}.tmp`, transfer, { flag: 'wx' });
  fs.writeFileSync(`${hermes}.tmp`, updatedHermes, { flag: 'wx' });
  fs.writeFileSync(`${imageHelper}.tmp`, image, { flag: 'wx' });
  fs.renameSync(`${helper}.tmp`, helper);
  fs.renameSync(`${imageHelper}.tmp`, imageHelper);
  fs.renameSync(`${hermes}.tmp`, hermes);
  fs.renameSync(`${connector}.tmp`, connector);
}

if (require.main === module) {
  if (process.argv.length !== 5) throw new Error('Usage: node khlink115-detail-patch.cjs STAGED_RELEASE LIGHT_DETAIL_TRANSFER HERMES_IMAGE_HELPER');
  install(process.argv[2], process.argv[3], process.argv[4]);
  process.stdout.write('Linux preview compatibility patch installed in staged release.\n');
}

module.exports = { patchPreviewSource, patchHermesSource, PREVIEW_V9_SHA256, HERMES_V9_SHA256, ROUTE, LEGACY, HERMES_BUSY, FILE_ACTIONS, CAPABILITIES };
