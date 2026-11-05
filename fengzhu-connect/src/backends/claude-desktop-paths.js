// Official Desktop data locations only. Discovery stats session metadata; it
// never opens login, cookie or token files, and never includes Claude-3p.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function roots(options = {}) {
  return {
    roaming: options.roaming || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    local: options.local || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  };
}

function claudeDataDirs(options) {
  const { roaming, local } = roots(options);
  const candidates = [path.join(roaming, 'Claude')];
  // Desktop 2.42304.0.0 migrated here on this Windows machine after reopening
  // on 2026-10-19. The former MSIX LocalCache directory may remain empty.
  for (const [base, suffix] of [[path.join(local, 'Claude-Data'), []], [path.join(local, 'Packages'), ['LocalCache', 'Roaming', 'Claude']]]) {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (/^claude_[\w.-]+$/i.test(entry.name) && entry.isDirectory()) candidates.push(path.join(base, entry.name, ...suffix));
      }
    } catch { /* Not every install has both layouts. */ }
  }
  return candidates;
}

function sessionStamp(dir) {
  const base = path.join(dir, 'claude-code-sessions');
  try {
    const baseTime = fs.statSync(base).mtimeMs;
    let latest = 0;
    for (const account of fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory())) {
      for (const org of fs.readdirSync(path.join(base, account.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
        const source = path.join(base, account.name, org.name);
        for (const name of fs.readdirSync(source)) if (/^local_[\w-]+\.json$/.test(name)) {
          try { latest = Math.max(latest, fs.statSync(path.join(source, name)).mtimeMs); } catch { /* atomic replacement */ }
        }
      }
    }
    return { populated: latest > 0, at: latest || baseTime };
  } catch { return null; }
}

function claudeAppDir(options) {
  const candidates = claudeDataDirs(options);
  let best = null;
  for (const dir of candidates) {
    const stamp = sessionStamp(dir);
    if (stamp && (!best || Number(stamp.populated) > Number(best.populated) ||
      (stamp.populated === best.populated && stamp.at > best.at))) best = { dir, ...stamp };
  }
  return best?.dir || candidates[0];
}

function realDesktopPath(dir, options) {
  if (!dir || fs.existsSync(dir)) return dir;
  const virtual = path.join(roots(options).roaming, 'Claude');
  if (!dir.toLowerCase().startsWith(virtual.toLowerCase() + path.sep)) return dir;
  for (const root of new Set([claudeAppDir(options), ...claudeDataDirs(options)])) {
    const candidate = path.join(root, dir.slice(virtual.length + 1));
    if (fs.existsSync(candidate)) return candidate;
  }
  return dir;
}

function desktopLogFiles(root = claudeAppDir(), options) {
  const current = path.join(root, 'logs', 'main.log');
  // Do not revive a pending prompt from a retired copy of the app's log.
  if (fs.existsSync(current)) return [current];
  const legacy = path.join(roots(options).local, 'Claude', 'logs', 'main.log');
  return [current, legacy];
}

function isDesktopClaudeBinaryPath(exe) {
  return /\\(?:Claude|ClaudeSwitch\\profiles\\[a-z][a-z0-9-]*|Claude-Data\\claude_[\w.-]+)\\claude-code\\/i.test(exe);
}

module.exports = { claudeDataDirs, claudeAppDir, realDesktopPath, desktopLogFiles, isDesktopClaudeBinaryPath };
