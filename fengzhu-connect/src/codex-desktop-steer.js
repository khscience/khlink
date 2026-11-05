'use strict';
// Runs scripts/codex-desktop-steer.ps1: hands a message to the turn Codex
// Desktop is running, through the window's own Queue and Steer controls.
// Codex Desktop 26.1027 hides its page from the native desktop adapter, and
// queue rows another app-server added are not shown in its window, so this is
// the one way left to steer a turn Desktop owns (2026-10-31).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'codex-desktop-steer.ps1');

class CodexDesktopSteer {
  constructor({ execFileFn = execFile, script = SCRIPT, tempDir = os.tmpdir(), timeoutMs = 40_000 } = {}) {
    this.execFileFn = execFileFn; this.script = script; this.tempDir = tempDir; this.timeoutMs = timeoutMs;
  }

  /** Resolves {code, delivery, message}: delivery is not_sent, confirmed or uncertain. */
  steer({ threadId, title, text, mode = 'steer' }) {
    if (!threadId || !String(title || '').trim() || !String(text || '').trim()) {
      return Promise.resolve({ code: 'missing_input', delivery: 'not_sent', message: '缺少任务标题或消息' });
    }
    if (!['steer', 'queue'].includes(mode)) {
      return Promise.resolve({ code: 'invalid_mode', delivery: 'not_sent', message: '不支持的发送方式' });
    }
    const file = path.join(this.tempDir, `khlink-codex-steer-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script,
      '-ThreadId', threadId, '-TitleB64', Buffer.from(String(title).trim(), 'utf8').toString('base64'), '-TextFile', file, '-Mode', mode];
    return new Promise((resolve) => {
      this.execFileFn('powershell.exe', args, { windowsHide: true, timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        try { fs.unlinkSync(file); } catch {}
        resolve(parseSteerOutput(String(stdout || ''), error));
      });
    });
  }
}

/** Editing can leave a draft even before the send button is pressed. */
function parseSteerOutput(stdout, error = null) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'));
  const wrote = lines.some((line) => /"phase"\s*:\s*"(?:editing|write)"/.test(line));
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line);
      if (value.code) {
        const reported = String(value.delivery || (wrote ? 'uncertain' : 'not_sent'));
        return { code: String(value.code), delivery: wrote && reported === 'not_sent' ? 'uncertain' : reported, message: String(value.message || '') };
      }
    } catch {}
  }
  return { code: error?.killed ? 'timeout' : 'script_failed', delivery: wrote ? 'uncertain' : 'not_sent', message: String(error?.message || '电脑端没有返回结果').slice(0, 200) };
}

module.exports = { CodexDesktopSteer, parseSteerOutput };
