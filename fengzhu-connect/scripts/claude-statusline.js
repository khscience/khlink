#!/usr/bin/env node
// khLink's Claude Code statusLine command, installed only while "终端 Claude
// Code 实时额度" is on (see src/claude-statusline.js). Claude Code runs it
// after each reply in an interactive terminal session and passes its session
// state on stdin. Only the five-hour and weekly quota and their reset times
// are kept, in the file named by the first argument; no other field is read
// or stored. The status line the user had before then runs with the same
// input, and its output is what Claude Code shows.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const out = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try { if (out) save(out, JSON.parse(input)); } catch { /* never break the status line */ }
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(path.dirname(out), 'claude-statusline-previous.json'), 'utf8')).statusLine?.command || null; } catch { /* none */ }
  if (!previous) return;
  const child = spawn(previous, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', () => process.exit(0));
  child.on('exit', (code) => process.exit(code ?? 0));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

function save(file, data) {
  const window = (value) => value && Number.isFinite(value.used_percentage) && value.used_percentage >= 0 && value.used_percentage <= 100
    ? { used: value.used_percentage, resetsAt: Number.isFinite(value.resets_at) ? value.resets_at : null } : null;
  const fiveHour = window(data?.rate_limits?.five_hour);
  const sevenDay = window(data?.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), fiveHour, sevenDay }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
