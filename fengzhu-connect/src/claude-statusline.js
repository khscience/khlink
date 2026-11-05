// Optional, off by default: "终端 Claude Code 实时额度". When the user turns it
// on, Claude Code's official statusLine setting points at
// scripts/claude-statusline.js, which writes the quota Claude Code itself
// hands to status lines after each reply. No credential is read, no request
// is made and no model turn is created. Only the `statusLine` key of the
// user's Claude Code settings is touched; whatever was there is kept beside
// the connector config and restored when the user turns it off. Claude
// Desktop does not run status lines, so this only helps terminal sessions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'claude-statusline.js');
const SNAPSHOT = 'claude-statusline.json';
const PREVIOUS = 'claude-statusline-previous.json';

function settingsFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

function isOurs(statusLine) {
  return typeof statusLine?.command === 'string' && statusLine.command.includes('claude-statusline.js') && statusLine.command.includes(SNAPSHOT);
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, value: {} };
    throw error;
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Claude Code 的设置文件不是有效的 JSON，没有修改'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 的设置文件格式不对，没有修改');
  return { exists: true, value };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

class ClaudeStatusline {
  constructor({ dataDir, settings = settingsFile(), node = process.execPath, script = SCRIPT }) {
    this.dataDir = dataDir; this.settings = settings; this.node = node; this.script = script;
    this.snapshotFile = path.join(dataDir, SNAPSHOT);
    this.previousFile = path.join(dataDir, PREVIOUS);
  }

  command() { return `"${this.node}" "${this.script}" "${this.snapshotFile}"`; }

  status() {
    try {
      const enabled = isOurs(readSettings(this.settings).value.statusLine);
      let chained = false;
      try { chained = Boolean(JSON.parse(fs.readFileSync(this.previousFile, 'utf8')).statusLine?.command); } catch { /* none */ }
      return { available: true, enabled, chained: enabled && chained };
    } catch (error) {
      return { available: true, enabled: false, chained: false, error: error.message };
    }
  }

  enable() {
    const { exists, value } = readSettings(this.settings);
    if (!isOurs(value.statusLine)) {
      // Keep what the user had, to run it after ours and to put it back later.
      writeJson(this.previousFile, { statusLine: value.statusLine ?? null, createdFile: !exists, savedAt: Date.now() });
      const statusLine = { ...(value.statusLine && typeof value.statusLine === 'object' ? value.statusLine : {}), type: 'command', command: this.command() };
      writeJson(this.settings, { ...value, statusLine });
    }
    return this.status();
  }

  disable() {
    const { exists, value } = readSettings(this.settings);
    if (exists && isOurs(value.statusLine)) {
      let previous = null;
      try { previous = JSON.parse(fs.readFileSync(this.previousFile, 'utf8')); } catch { /* restore nothing */ }
      const next = { ...value };
      if (previous?.statusLine) next.statusLine = previous.statusLine; else delete next.statusLine;
      if (previous?.createdFile && Object.keys(next).length === 0) fs.rmSync(this.settings, { force: true });
      else writeJson(this.settings, next);
    }
    fs.rmSync(this.previousFile, { force: true });
    return this.status();
  }

  set(enabled) { return enabled ? this.enable() : this.disable(); }

  // The newest quota the hook wrote, or null.
  snapshot() {
    try {
      const data = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      return Number.isFinite(data?.at) ? data : null;
    } catch { return null; }
  }
}

// The hook's quota in the shape Claude Code's rate_limit_event uses.
function rateLimitInfo(snapshot) {
  const window = (value) => value ? { utilization: value.used / 100, resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : undefined } : undefined;
  return { unifiedWindows: { five_hour: window(snapshot.fiveHour), seven_day: window(snapshot.sevenDay) } };
}

module.exports = { ClaudeStatusline, rateLimitInfo, settingsFile, isOurs };
