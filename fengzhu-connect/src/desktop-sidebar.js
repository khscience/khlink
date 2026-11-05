// Pin / unpin / rename (and, for Claude, archive / unarchive) a task in the Codex or Claude desktop sidebar from the
// phone, through scripts/desktop-sidebar.ps1 (UI Automation on the app's own
// controls). One operation at a time: each briefly brings its app in front.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SIDEBAR_SCRIPT = path.join(__dirname, '..', 'scripts', 'desktop-sidebar.ps1');

const SIDEBAR_ERRORS = {
  desktop_not_running: '电脑端没有打开，请先在电脑上打开它',
  row_not_found: '电脑端侧边栏里没找到这个任务（可能收在折叠的项目里），请在电脑上操作',
  ambiguous_title: '电脑端有同名的任务，为免改错，请在电脑上操作',
  ambiguous_pin: '电脑端有好几个同名的会话（比如定时任务每天跑的），置顶请在电脑上操作；重命名、归档可以在手机上做',
  button_not_found: '电脑端没有出现对应的按钮，请在电脑上操作',
  menu_not_found: '电脑端的菜单没有打开，请在电脑上操作',
  text_not_set: '没能在电脑端填入新名字，请在电脑上改',
  prompt_mismatch: '电脑端正在编辑的不是这个任务，已取消',
  window_not_foreground: '电脑端窗口没能切到前台，请在电脑上操作',
  bad_title: '这个任务没有标题，无法在电脑端定位',
  bad_choice: '不支持的操作',
  not_applied: '电脑端没有生效，请在电脑上操作',
  status_not_set: '没能把电脑端侧边栏切到「已归档」列表，请在电脑上操作',
  status_not_restored: '操作已执行，但电脑侧栏筛选未恢复，请检查电脑；不要重复操作',
  cleanup_failed: '操作结果待确认，电脑界面未完全恢复，请在电脑上检查',
  bad_output: '电脑端的操作脚本没有正常返回结果，请在电脑上操作',
  script_failed: '电脑端的操作脚本没能运行，请在电脑上操作',
  timeout: '电脑端操作超时，请在电脑上看看是否已经完成',
};

let chain = Promise.resolve();

// Resolves to the script's {ok, reason, state}; never rejects.
function runSidebarScript({ app, action, title, name = '', threadId = '', sessionId = '', viaToolbar = false, execFileFn = execFile }) {
  const run = chain.then(() => new Promise((resolve) => {
    const temp = [];
    const file = (text) => { const f = path.join(os.tmpdir(), `kh-link-sidebar-${crypto.randomUUID()}.txt`); fs.writeFileSync(f, String(text), { encoding: 'utf8', mode: 0o600 }); temp.push(f); return f; };
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SIDEBAR_SCRIPT, '-App', app, '-Action', action, '-TitleFile', file(title)];
    if (name) args.push('-NameFile', file(name));
    if (threadId) args.push('-ThreadId', threadId);
    if (viaToolbar && sessionId) args.push('-SessionId', sessionId, '-ViaToolbar');
    execFileFn('powershell.exe', args, { windowsHide: true, timeout: 45_000 }, (error, stdout) => {
      for (const f of temp) fs.rm(f, { force: true }, () => {});
      if (error && !stdout) return resolve({ ok: false, reason: error.killed ? 'timeout' : 'script_failed' });
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { resolve({ ok: false, reason: 'bad_output' }); }
    });
  }));
  chain = run.catch(() => {});
  return run;
}

function sidebarError(reason) { return new Error(SIDEBAR_ERRORS[reason] || SIDEBAR_ERRORS.script_failed); }

// Polls `check` until it returns true (or the time is up).
async function waitUntil(check, { timeoutMs = 6_000, stepMs = 300 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return true; } catch { /* keep polling */ }
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

module.exports = { runSidebarScript, sidebarError, waitUntil, SIDEBAR_ERRORS };
