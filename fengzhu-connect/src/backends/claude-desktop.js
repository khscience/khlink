// Read-side bridge to the Claude desktop app (Code tab) on this machine.
//
// Everything here is local file access: session metadata the app keeps under
// %APPDATA%\Claude\claude-code-sessions, the sidebar pin order in its Local
// Storage (a LevelDB we only *read*, never open or lock), and the Claude Code
// transcripts under ~/.claude/projects. No network call is made and no
// credential file is touched. The only write is registerSession(), which adds
// a metadata file for a session created from the phone so the desktop sidebar
// lists it the next time the app loads its session list.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { usageResetBrackets } = require('./claude-usage');
const { wrapUpItem } = require('./claude-wrap-up');
const { TOOL: TASK_LIST_TOOL, applyTaskListUpdate, finishTaskList, taskListItem, cardOrder } = require('./claude-task-list');
const { sentFilesItem, deliveredFiles } = require('./claude-sent-files');
const { claudeAppDir, realDesktopPath, desktopLogFiles, isDesktopClaudeBinaryPath } = require('./claude-desktop-paths');

function compareVersions(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d;
  }
  return 0;
}

// The desktop app ships its own (newer) Claude Code under
// %APPDATA%\Claude\claude-code\<version>\claude.exe. Newer desktop builds
// add a content-addressed hash directory:
// <version>\<hash>\claude.exe, with a `.verified` marker beside the binary.
// Keep this lookup read-only: the marker is the desktop's signal that the
// downloaded binary has passed its own verification step.
function findDesktopClaudeBin(root = path.join(claudeAppDir(), 'claude-code')) {
  try {
    const versions = fs.readdirSync(root).filter((name) => /^\d+(\.\d+)+$/.test(name)).sort(compareVersions).reverse();
    for (const version of versions) {
      const versionRoot = path.join(root, version);
      const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
      // 2.1.286+ uses <version>/<hash>/.verified + claude.exe. Prefer a
      // verified nested binary when both layouts are present. The hash folder
      // is not a version, so never let it affect the version ordering above.
      const nested = fs.readdirSync(versionRoot).filter((name) => {
        try { return fs.statSync(path.join(versionRoot, name)).isDirectory(); } catch { return false; }
      }).map((name) => {
        const dir = path.join(versionRoot, name);
        return { dir, verified: fs.existsSync(path.join(dir, '.verified')), bin: path.join(dir, executable) };
      }).filter((candidate) => candidate.verified && fs.existsSync(candidate.bin));
      if (nested.length) return { bin: nested[0].bin, version };
      // Older builds put the executable directly under the version folder.
      const direct = path.join(versionRoot, executable);
      if (fs.existsSync(direct)) return { bin: direct, version };
      // Be tolerant of an interrupted first install: if the marker has not
      // landed yet, a nested binary is still preferable to falling back to a
      // system Claude installation. A later poll will choose the verified
      // copy once the desktop finishes its install.
      const unverified = fs.readdirSync(versionRoot).filter((name) => {
        try { return fs.statSync(path.join(versionRoot, name)).isDirectory(); } catch { return false; }
      }).map((name) => path.join(versionRoot, name, executable)).find((bin) => fs.existsSync(bin));
      if (unverified) return { bin: unverified, version };
    }
  } catch { /* not installed */ }
  return null;
}

// ---- LevelDB (read-only) -------------------------------------------------
function varint(buf, pos) { let r = 0, s = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return [r, pos]; }

function snappyDecompress(src) {
  let [len, p] = varint(src, 0); const out = Buffer.alloc(len); let o = 0;
  while (p < src.length) {
    const tag = src[p++]; const type = tag & 3;
    if (type === 0) {
      let l = tag >> 2;
      if (l >= 60) { const n = l - 59; l = 0; for (let i = 0; i < n; i++) l |= src[p++] << (8 * i); }
      l += 1; src.copy(out, o, p, p + l); p += l; o += l; continue;
    }
    let l, off;
    if (type === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
    else if (type === 2) { l = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { l = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
    for (let i = 0; i < l; i++) { out[o] = out[o - off]; o++; }
  }
  return out;
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  return file[offset + size] === 1 ? snappyDecompress(raw) : raw;
}

function blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4); const end = block.length - 4 - restarts * 4;
  const out = []; let p = 0; let key = Buffer.alloc(0);
  while (p < end) {
    let shared, nonShared, valueLength;
    [shared, p] = varint(block, p); [nonShared, p] = varint(block, p); [valueLength, p] = varint(block, p);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(p, p + nonShared)]); p += nonShared;
    out.push([key, block.subarray(p, p + valueLength)]); p += valueLength;
  }
  return out;
}

function tableEntries(file) {
  const footer = file.subarray(file.length - 48); let p = 0, indexOffset, indexSize;
  [, p] = varint(footer, p); [, p] = varint(footer, p); [indexOffset, p] = varint(footer, p); [indexSize, p] = varint(footer, p);
  const out = [];
  for (const [, handle] of blockEntries(readBlock(file, indexOffset, indexSize))) {
    let q = 0, offset, size; [offset, q] = varint(handle, q); [size, q] = varint(handle, q);
    out.push(...blockEntries(readBlock(file, offset, size)));
  }
  return out;
}

// LevelDB write-ahead log: 32 KiB blocks of records; each full/first..last
// record carries a WriteBatch (seq, count, then Put/Delete entries).
function logBatches(file) {
  const batches = []; let pending = [];
  for (let block = 0; block < file.length; block += 32768) {
    let p = block;
    while (p + 7 <= Math.min(block + 32768, file.length)) {
      const length = file.readUInt16LE(p + 4); const type = file[p + 6];
      if (type === 0 && length === 0) break;
      const data = file.subarray(p + 7, p + 7 + length); p += 7 + length;
      if (type === 1) batches.push(data);
      else if (type === 2) pending = [data];
      else if (type === 3) pending.push(data);
      else if (type === 4) { pending.push(data); batches.push(Buffer.concat(pending)); pending = []; }
    }
  }
  const out = [];
  for (const batch of batches) {
    if (batch.length < 12) continue;
    let seq = Number(batch.readBigUInt64LE(0)); const count = batch.readUInt32LE(8); let p = 12;
    for (let i = 0; i < count && p < batch.length; i++, seq++) {
      const kind = batch[p++]; let length;
      [length, p] = varint(batch, p); const key = batch.subarray(p, p + length); p += length;
      if (kind === 1) { [length, p] = varint(batch, p); out.push({ key, value: batch.subarray(p, p + length), seq }); p += length; }
      else out.push({ key, value: null, seq });
    }
  }
  return out;
}

// Chromium localStorage value: 0x00 prefix = UTF-16LE, 0x01 = Latin-1.
function localStorageText(value) {
  if (!value || !value.length) return '';
  return value[0] === 0 ? value.subarray(1).toString('utf16le') : value.subarray(1).toString('latin1');
}

// Newest value of every localStorage key whose text contains `needle`.
function readLocalStorage(dir, needle) {
  const latest = new Map();
  const consider = (key, value, seq) => {
    const name = key.toString('latin1'); const prior = latest.get(name);
    if (prior && prior.seq > seq) return;
    latest.set(name, { seq, text: value ? localStorageText(value) : null });
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return latest; }
  for (const name of names.filter((n) => n.endsWith('.ldb'))) {
    try {
      for (const [internalKey, value] of tableEntries(fs.readFileSync(path.join(dir, name)))) {
        const tag = internalKey.readBigUInt64LE(internalKey.length - 8);
        consider(internalKey.subarray(0, internalKey.length - 8), (Number(tag & 0xffn) === 1) ? value : null, Number(tag >> 8n));
      }
    } catch { /* a table being compacted right now; the next poll reads it */ }
  }
  for (const name of names.filter((n) => n.endsWith('.log'))) {
    try { for (const { key, value, seq } of logBatches(fs.readFileSync(path.join(dir, name)))) consider(key, value, seq); } catch { /* partial tail */ }
  }
  for (const [name, entry] of latest) if (!entry.text || !entry.text.includes(needle)) latest.delete(name);
  return latest;
}

// ---- transcripts ---------------------------------------------------------
function projectDirName(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'); }

function transcriptPath(cwd, cliSessionId, root = path.join(os.homedir(), '.claude', 'projects')) {
  if (!cliSessionId) return null;
  const direct = path.join(root, projectDirName(cwd), `${cliSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* no projects dir */ }
  return null;
}

const TOOL_TYPES = { Bash: 'commandExecution', PowerShell: 'commandExecution', Edit: 'fileChange', Write: 'fileChange', MultiEdit: 'fileChange', NotebookEdit: 'fileChange', TodoWrite: 'plan', WebSearch: 'webSearch', WebFetch: 'webSearch' };

function toolSummary(name, input = {}) {
  if (input.command) return String(input.command);
  if (input.file_path) return `${name} ${input.file_path}`;
  if (input.url) return `${name} ${input.url}`;
  if (input.query) return `${name} ${input.query}`;
  if (input.pattern) return `${name} ${input.pattern}`;
  if (input.description) return `${name}: ${input.description}`;
  return name;
}

// Reminders the app puts in front of what the user typed (seen: a phone task
// continued in Claude desktop gets "<system-reminder>This conversation is now
// continuing in the Claude desktop app…" as the first text block, the user's
// words after it). Only the reminders go; the typed text stays.
function withoutLeadingReminders(text) {
  let rest = String(text || '');
  for (;;) {
    const next = rest.replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '');
    if (next === rest) return rest;
    rest = next;
  }
}

function userText(content) {
  if (typeof content === 'string') return withoutLeadingReminders(content) || content;
  if (!Array.isArray(content)) return '';
  if (content.some((block) => block?.type === 'tool_result')) return '';
  const texts = content.filter((block) => block?.type === 'text').map((block) => withoutLeadingReminders(block.text));
  const typed = texts.filter((text) => text.trim() && !isInternalUserText(text));
  // Nothing but harness text: keep it whole, so the caller still recognises it as internal.
  return (typed.length ? typed : content.filter((block) => block?.type === 'text').map((block) => block.text)).join('\n');
}

// Images the user attached to a message, as data URIs the phone can show.
// Capped so one message cannot flood the (throttled) relay.
const MAX_HISTORY_IMAGE_CHARS = 2_000_000;
const MAX_HISTORY_IMAGES = 4;
function userImages(content) {
  if (!Array.isArray(content) || content.some((block) => block?.type === 'tool_result')) return [];
  const images = [];
  for (const block of content) {
    if (images.length >= MAX_HISTORY_IMAGES) break;
    const source = block?.type === 'image' ? block.source : null;
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue;
    const mimeType = /^image\/[a-z0-9.+-]+$/i.test(source.media_type || '') ? source.media_type.toLowerCase() : 'image/png';
    const data = `data:${mimeType};base64,${source.data}`;
    if (data.length <= MAX_HISTORY_IMAGE_CHARS) images.push({ data, mimeType });
  }
  return images;
}

// Images that came back from tools (screenshots, images opened with Read …).
// Only a reference goes to the phone; it loads the picture itself on request
// (see readTranscriptImage), so a busy session does not push every
// screenshot through the relay. A ref is "<row uuid>/<block>/<sub-block>".
function toolResultImageRefs(row) {
  const content = row?.message?.content;
  if (!Array.isArray(content)) return [];
  const refs = [];
  content.forEach((block, blockIndex) => {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return;
    block.content.forEach((part, partIndex) => {
      if (part?.type !== 'image' || part.source?.type !== 'base64' || typeof part.source.data !== 'string') return;
      const mimeType = /^image\/[a-z0-9.+-]+$/i.test(part.source.media_type || '') ? part.source.media_type.toLowerCase() : 'image/png';
      refs.push({ ref: `${row.uuid}/${blockIndex}/${partIndex}`, mimeType, bytes: Buffer.byteLength(part.source.data, 'base64') });
    });
  });
  return refs;
}

// Where a row sits in a transcript, found once: transcripts only grow, so the
// byte range stays valid. Keyed by file and row uuid.
const transcriptRowRanges = new Map();

// The whole line holding byte `at`, read around it (a line can be megabytes of base64).
function lineAround(fd, size, at) {
  const step = 1 << 20; const scratch = Buffer.alloc(step);
  let start = at;
  while (start > 0) {
    const from = Math.max(0, start - step); const n = fs.readSync(fd, scratch, 0, start - from, from);
    const newline = scratch.subarray(0, n).lastIndexOf(10);
    if (newline >= 0) { start = from + newline + 1; break; }
    start = from;
  }
  let end = at;
  while (end < size) {
    const n = fs.readSync(fd, scratch, 0, Math.min(step, size - end), end);
    const newline = scratch.subarray(0, n).indexOf(10);
    if (newline >= 0) { end += newline; break; }
    end += n;
  }
  return { start, end };
}

// The transcript row with this uuid, scanning the file in chunks: a long
// session's transcript runs to hundreds of MB, too big to read whole (and,
// past ~512 MB, too long for one string).
function readTranscriptRow(file, uuid) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const key = `${file}|${uuid}`;
    let range = transcriptRowRanges.get(key);
    if (!range || range.end > size) {
      range = null;
      const needle = Buffer.from(`"uuid":"${uuid}"`); const chunk = 8 << 20;
      const buffer = Buffer.alloc(chunk + needle.length);
      let position = 0; let carry = 0;
      while (position < size && !range) {
        const n = fs.readSync(fd, buffer, carry, chunk, position);
        if (!n) break;
        const view = buffer.subarray(0, carry + n); const hit = view.indexOf(needle);
        if (hit >= 0) range = lineAround(fd, size, position - carry + hit);
        else { carry = Math.min(needle.length - 1, view.length); view.copy(buffer, 0, view.length - carry); position += n; }
      }
      if (!range) return null;
      if (transcriptRowRanges.size > 500) transcriptRowRanges.clear();
      transcriptRowRanges.set(key, range);
    }
    const line = Buffer.alloc(range.end - range.start); fs.readSync(fd, line, 0, line.length, range.start);
    return JSON.parse(line.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// The image a ref points to, as raw bytes, read from the transcript on disk.
function readTranscriptImage(file, ref) {
  const [uuid, blockIndex, partIndex] = String(ref || '').split('/');
  if (!/^[0-9a-f-]{36}$/i.test(uuid || '')) throw new Error('无效的图片引用');
  const row = readTranscriptRow(file, uuid);
  if (!row) throw new Error('找不到这张图片');
  const part = row?.message?.content?.[Number(blockIndex)]?.content?.[Number(partIndex)];
  if (part?.type !== 'image' || typeof part.source?.data !== 'string') throw new Error('找不到这张图片');
  return { bytes: Buffer.from(part.source.data, 'base64'), mimeType: part.source.media_type || 'image/png' };
}

const TURN_CONTINUES = new Set(['tool_use', 'pause_turn']);
// A tool result saying the user stopped it ("[Request interrupted by user for tool use]").
function interruptedToolResult(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'tool_result' && (typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')).includes('[Request interrupted by user'));
}

// Harness-injected user turns (command wrappers, reminders) are not things the
// user typed; keep them out of the phone's conversation. Claude desktop also
// writes its own events as user lines: a side session finished, a message from
// another session, a scheduled task or CI event starting a turn. The desktop
// does not show them as the user's messages, so neither does the phone.
const DESKTOP_EVENT_TAGS = 'side-sessions-event|cross-session-message|scheduled-task|ci-monitor-event';
const DESKTOP_EVENT_TEXT = new RegExp(`^\\s*<(${DESKTOP_EVENT_TAGS})[\\s>]`);
const INTERNAL_USER_TAGS = `command-name|command-message|local-command|system-reminder|task-notification|bash-input|bash-stdout|user-prompt-submit-hook|${DESKTOP_EVENT_TAGS}`;
const INTERNAL_USER_TEXT = new RegExp(`^\\s*<(${INTERNAL_USER_TAGS})[\\s>]`);
function isInternalUserText(text) {
  return INTERNAL_USER_TEXT.test(text)
    || /^\s*\[Request interrupted/.test(text) || /^Caveat: The messages below/.test(text);
}

// Convert transcript lines to conversation items. `lineIndex` keeps `order`
// stable across incremental reads; ids are the transcript uuids so re-reads
// upsert instead of duplicating.
function transcriptItems(lines, startLine = 0, state = {}) {
  const items = []; let lineIndex = startLine;
  state.wrapUpCalls = { ...(state.wrapUpCalls || {}) };
  state.sentFileCalls = { ...(state.sentFileCalls || {}) };
  const setTaskList = (list) => { if (!list) return; state.taskList = list; upsert(taskListItem(list)); };
  const upsert = item => { const index = items.findIndex(previous => previous.id === item.id); if (index < 0) items.push(item); else items[index] = item; };
  for (const raw of lines) {
    const line = lineIndex++;
    let row; try { row = JSON.parse(raw); } catch { continue; }
    if (row?.type === 'queue-operation') {
      if (!state.queueOps) state.queueOps = [];
      // Claude desktop puts "<system-reminder>Linked sessions now…" in front of
      // a message absorbed mid-turn; the typed words come after it.
      const opAt = Date.parse(row.timestamp) || Date.now(); const content = typeof row.content === 'string' ? withoutLeadingReminders(row.content) : '';
      state.queueOps.push({ op: row.operation, content, at: opAt, reason: row.reason || null });
      // A queued message absorbed mid-turn never gets its own user line; show it
      // in the conversation where Claude picked it up.
      if (row.operation === 'remove' && row.reason === 'absorbed_mid_turn' && content.trim() && !isInternalUserText(content) && !/^\s*</.test(content)) {
        items.push({ id: `qa-${crypto.createHash('sha1').update(`${row.timestamp}|${content}`).digest('hex').slice(0, 16)}`, order: line * 16, type: 'userMessage', text: content, at: opAt });
      }
      continue;
    }
    if (!row || row.isSidechain || row.isMeta || !row.uuid) continue;
    const at = Date.parse(row.timestamp) || Date.now();
    if (row.type === 'user') {
      const text = userText(row.message?.content).trim();
      if (text && !/^\[Request interrupted/.test(text)) {
        if (!state.queueOps) state.queueOps = [];
        state.queueOps.push({ op: 'received', content: text, at });
      }
      // A local slash command (/model, /effort …) is recorded as user lines but
      // runs no turn; it must not make the session look busy.
      const localCommand = /^\s*<(command-name|command-message|local-command)/.test(text);
      if ((Array.isArray(row.message?.content) || typeof row.message?.content === 'string') && !localCommand) { state.lastEvent = 'user'; state.lastEventAt = at; state.lastTerminalStatus = null; }
      // Stopping a turn leaves this marker as its last line: the turn is over.
      if (/^\[Request interrupted/.test(text) || interruptedToolResult(row.message?.content)) { state.lastEvent = 'end_turn'; state.lastTerminalStatus = 'interrupted'; }
      const images = userImages(row.message?.content);
      // The next-step box ends a turn. Correlate its real tool result, even
      // when the call and result arrive in separate incremental reads.
      for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
        const card = block.type === 'tool_result' && state.wrapUpCalls[block.tool_use_id];
        if (!card) continue;
        upsert({ ...card, status: block.is_error ? 'failed' : 'completed' });
        delete state.wrapUpCalls[block.tool_use_id];
        if (!block.is_error) { state.lastEvent = 'end_turn'; state.lastEventAt = at; state.lastTerminalStatus = null; }
      }
      for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
        const card = block.type === 'tool_result' && state.sentFileCalls[block.tool_use_id];
        if (!card) continue;
        upsert(deliveredFiles(card, row.toolUseResult, block.is_error));
        delete state.sentFileCalls[block.tool_use_id];
      }
      if (text && !isInternalUserText(text)) { state.wrapUpCalls = {}; if (state.taskList) state.taskListNewTurn = true; }
      if ((text || images.length) && !isInternalUserText(text)) items.push({ id: `${row.uuid}:0`, order: line * 16, type: 'userMessage', text, at, ...(images.length ? { images } : {}) });
      // Connector 0.2.137 and earlier showed desktop events as user messages;
      // a rebuilt history replaces those rows with hidden ones under the same id.
      else if (DESKTOP_EVENT_TEXT.test(text)) items.push({ id: `${row.uuid}:0`, order: line * 16, type: 'hidden', text: '', at });
      const imageRefs = toolResultImageRefs(row);
      if (imageRefs.length) items.push({ id: `${row.uuid}:img`, order: line * 16 + 1, type: 'toolImages', text: '', at, imageRefs });
    } else if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      // Only a tool call (or a paused long turn) continues the turn; any other
      // stop reason ends it: end_turn, and also stop_sequence (API errors are
      // written this way), max_tokens and refusal, which otherwise kept the
      // session "busy" and its queued messages waiting for 20 minutes.
      if (row.message.stop_reason) { state.lastStopReason = row.message.stop_reason; state.lastAssistantAt = at; state.lastEvent = TURN_CONTINUES.has(row.message.stop_reason) ? 'assistant' : 'end_turn'; state.lastEventAt = at; state.lastTerminalStatus = null; }
      row.message.content.forEach((block, index) => {
        const base = { id: `${row.uuid}:${index}`, order: line * 16 + Math.min(index, 15), at };
        if (block.type === 'text' && block.text?.trim()) items.push({ ...base, type: 'agentMessage', text: block.text });
        else if (block.type === 'thinking' && (block.thinking || '').trim()) items.push({ ...base, type: 'reasoning', text: block.thinking });
        else if (block.type === 'tool_use') {
          if (block.name === TASK_LIST_TOOL) {
            // Shown as the turn's task list card, not as a tool call (the id
            // is reused so a rebuilt history drops the old tool row).
            items.push({ ...base, type: 'hidden', text: '' });
            const list = applyTaskListUpdate(state.taskList, block.input, { ...base, cardOrder: cardOrder(line) }, state.taskListNewTurn);
            if (list && list.id !== state.taskList?.id) state.taskListNewTurn = false;
            setTaskList(list);
            return;
          }
          const files = sentFilesItem(block, base);
          const card = files ? null : wrapUpItem(block, base);
          if (files) {
            state.sentFileCalls[block.id] = files;
            for (const key of Object.keys(state.sentFileCalls).slice(0, -32)) delete state.sentFileCalls[key];
            upsert(files);
          } else if (card) {
            // Checked off in place: moved past the box, it greyed out the box's
            // buttons on apps that take the last row as the open one (0.2.99).
            setTaskList(finishTaskList(state.taskList, at));
            state.wrapUpCalls[block.id] = card;
            for (const key of Object.keys(state.wrapUpCalls).slice(0, -32)) delete state.wrapUpCalls[key];
            upsert(card);
          } else items.push({ ...base, type: TOOL_TYPES[block.name] || (block.name === 'AskUserQuestion' ? 'plan' : 'mcpToolCall'), tool: block.name, text: toolSummary(block.name, block.input) });
        }
      });
    }
  }
  return items;
}

// Read new transcript lines after `offset` bytes. Only complete lines are
// consumed so a line being appended is picked up whole next time.
function readTranscript(file, offset = 0, lineCount = 0, previousState = {}) {
  let size; try { size = fs.statSync(file).size; } catch { return null; }
  if (size < offset) { offset = 0; lineCount = 0; }
  if (size === offset) return { items: [], offset, lineCount };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - offset); fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(0x0a); if (end < 0) return { items: [], offset, lineCount };
    const lines = buffer.subarray(0, end).toString('utf8').split('\n');
    const state = { wrapUpCalls: offset > 0 ? previousState.wrapUpCalls : {}, sentFileCalls: offset > 0 ? previousState.sentFileCalls : {},
      taskList: offset > 0 ? previousState.taskList || null : null, taskListNewTurn: offset > 0 ? !!previousState.taskListNewTurn : false };
    return { items: transcriptItems(lines, lineCount, state), offset: offset + end + 1, lineCount: lineCount + lines.length, ...state };
  } finally { fs.closeSync(fd); }
}

// Last turn state from the tail of a transcript (no history upload).
function peekTranscriptState(file, tailBytes = 64 * 1024) {
  let size; try { size = fs.statSync(file).size; } catch { return null; }
  const start = Math.max(0, size - tailBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is partial
    const state = {};
    transcriptItems(lines.filter(Boolean), 0, state);
    return state;
  } finally { fs.closeSync(fd); }
}

// What an unanswered prompt is about: the newest tool call in the transcript
// tail that has no result yet (optionally of a given tool), shaped for the
// phone. Returns null when there is none.
// A session starting or suggesting a side session (Claude Desktop 3.x).
const START_SESSION_TOOL = 'mcp__ccd_session__start_session';
const OFFER_NEW = '新会话';
const OFFER_HERE = '在这里做';

function pendingToolUse(file, tool, tailBytes = 256 * 1024) {
  let size; try { size = fs.statSync(file).size; } catch { return null; }
  const start = Math.max(0, size - tailBytes);
  const fd = fs.openSync(file, 'r');
  let text;
  try { const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start); text = buffer.toString('utf8'); } finally { fs.closeSync(fd); }
  const lines = text.split('\n'); if (start > 0) lines.shift();
  const calls = []; const answered = new Set();
  for (const line of lines) {
    if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    for (const block of Array.isArray(row?.message?.content) ? row.message.content : []) {
      if (row.type === 'assistant' && block?.type === 'tool_use') calls.push(block);
      else if (row.type === 'user' && block?.type === 'tool_result') answered.add(block.tool_use_id);
    }
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (answered.has(call.id) || (tool && call.name !== tool)) continue;
    return describeToolUse(call);
  }
  return null;
}

const clipText = (value, max) => { const s = String(value ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s; };
function describeToolUse(call) {
  const input = call.input || {};
  if (call.name === 'AskUserQuestion') {
    const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 4).map((q) => ({
      question: clipText(q.question, 500), header: clipText(q.header, 40), multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clipText(o.label, 80), description: clipText(o.description, 200) })),
    }));
    return { kind: 'question', tool: call.name, toolUseId: call.id, questions };
  }
  if (call.name === 'ExitPlanMode') return { kind: 'plan', tool: call.name, toolUseId: call.id, summary: clipText(input.plan, 8000) };
  // Claude Desktop 3.x: a session suggesting a side session waits on a
  // "Start this in its own session?" card (New session / Do it here).
  if (call.name === START_SESSION_TOOL) {
    if (input.initiation !== 'offer') return { kind: 'sessionStart', tool: call.name, toolUseId: call.id, title: clipText(input.title, 200) };
    const title = clipText(String(input.title || '').trim(), 200);
    return {
      kind: 'question', source: 'session-offer', tool: call.name, toolUseId: call.id, title,
      questions: [{
        question: title ? `要单独开一个新会话来做「${title}」吗？` : '要单独开一个新会话来做这件事吗？', header: '新会话', multiSelect: false,
        options: [{ label: OFFER_NEW, description: '在新会话里做，这个会话继续' }, { label: OFFER_HERE, description: '就在这个会话里做' }],
      }],
    };
  }
  const summary = input.command || input.file_path || input.notebook_path || input.url || input.pattern || input.description
    || clipText(JSON.stringify(input), 300);
  return { kind: 'permission', tool: call.name, toolUseId: call.id, summary: clipText(summary, 800), description: clipText(input.description, 200) };
}

// ---- model catalogue -----------------------------------------------------
function modelLabel(model) {
  const short = String(model.description || '').split(' · ')[0].replace(/ with 1M context/i, ' (1M)').trim();
  if (model.value === 'default') return short ? `默认 · ${short}` : '默认';
  return short || model.displayName || model.value;
}

// Pretty name for a stored model id such as "claude-opus-5-5".
function prettyModelId(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(String(id || ''));
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${/\[1m\]/i.test(id) ? ' (1M)' : ''}`;
}

// Ask the local Claude Code for its model list via the stream-json
// `initialize` control request. It is answered locally before any turn, so no
// model request (and no usage) happens. Only model fields are returned; the
// account block in the response is discarded here.
function probeModels(bin, { spawnFn = spawn, env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = ''; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('claude initialize timed out')), timeoutMs);
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'control_response') continue;
        const models = (event.response?.response || event.response || {}).models;
        if (!Array.isArray(models)) return finish(new Error('claude initialize returned no models'));
        return finish(null, models.map((model) => ({
          value: String(model.value), displayName: model.displayName || model.value, description: model.description || '',
          label: modelLabel(model), efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(String) : [],
        })));
      }
    });
    child.on('error', (error) => finish(error));
    child.on('exit', () => finish(new Error('claude exited before initialize')));
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `init-${crypto.randomUUID()}`, request: { subtype: 'initialize' } })}\n`);
  });
}

// ---- desktop "waiting for you" (the yellow sidebar dot) -------------------
// The desktop logs every tool permission prompt it shows (including
// AskUserQuestion / ExitPlanMode) and every answer:
//   Emitted tool permission request <id> for <Tool> in session local_…
//   Received permission response for <id>: once (tool: <Tool>)
//   Permission request <id> for <Tool> aborted
// A request neither answered nor aborted is exactly a session waiting on the
// user. An abort (seen: computer:request_access after ~5 minutes) takes the
// prompt off the desktop without a response line.
const PERMISSION_EMITTED = /^(\S+ \S+) \[\w+\] Emitted tool permission request (\S+) for (\S+) in session (local_[0-9a-f-]{36})/;
const PERMISSION_RECEIVED = /Received permission response for (\S+):/;
const PERMISSION_ABORTED = /\] Permission request (\S+) for \S+ (?:aborted|cancell?ed|timed out|expired)\b/;
const PENDING_MAX_AGE_MS = 24 * 3600_000;
// "[CCD] side session offered task_x <- local_<session>": that session now waits
// on a New session / Do it here card. Its answer, or expiry, is logged too.
const SIDE_OFFERED = /^(\S+ \S+) \[\w+\] \[CCD\] side session offered (task_[0-9a-f]+) <- (local_[0-9a-f-]{36})/;
const SIDE_OFFER_DONE = /\[CCD\] (?:offer (task_[0-9a-f]+) brief\b|proposal (task_[0-9a-f]+) of \S+ expired|offer (task_[0-9a-f]+) (?:declined|done here|kept here|dismissed))/;
// A folder's trust is checked before a session opens there; when it is not
// trusted the desktop shows "Trust this workspace?" until someone answers.
const TRUST_CHECKED = /^(\S+ \S+) \[\w+\] LocalSessions\.checkTrust: cwd=(.+?)\s*$/;
const TRUST_SAVED = /LocalSessions\.saveTrust: cwd=(.+?)\s*$/;
const TRUST_WINDOW_MS = 15 * 60_000;
const folderKey = (value) => String(value || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

class DesktopPermissionLog {
  constructor(files) { this.files = files; this.file = null; this.offset = 0; this.pending = new Map(); this.offers = new Map(); this.trustChecks = new Map(); this.startCheck = 0; this.startingAt = 0; this.appStartedAt = 0; }

  currentFile() {
    let best = null;
    for (const file of this.files) { try { const { mtimeMs } = fs.statSync(file); if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs }; } catch { /* absent */ } }
    return best?.file || null;
  }

  // Read what was appended since last time; returns Map desktopId -> { requestId, tool, at }.
  poll(now = Date.now()) {
    const file = this.currentFile(); if (!file) return this.bySession(now);
    let size; try { size = fs.statSync(file).size; } catch { return this.bySession(now); }
    if (file !== this.file || size < this.offset) {
      // New or rotated log: rebuild from its recent tail.
      this.file = file; this.pending.clear(); this.offers.clear(); this.trustChecks.clear(); this.offset = Math.max(0, size - 3 * 1024 * 1024);
    }
    if (size > this.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(size - this.offset); fs.readSync(fd, buffer, 0, buffer.length, this.offset);
        const end = buffer.lastIndexOf(0x0a);
        if (end >= 0) { this.consume(buffer.subarray(0, end).toString('utf8').split(/\r?\n/)); this.offset += end + 1; }
      } finally { fs.closeSync(fd); }
    }
    return this.bySession(now);
  }

  consume(lines) {
    for (const line of lines) {
      if (this.startCheck > 0) {
        // A deep link spawns a second instance that exits at once; only a real
        // main-instance start drops prompts that can no longer be answered.
        if (line.includes('Not main instance')) this.startCheck = 0;
        else if (--this.startCheck === 0) { this.pending.clear(); this.offers.clear(); this.trustChecks.clear(); this.appStartedAt = this.startingAt; }
      }
      if (line.includes('Starting app {')) { this.startCheck = 15; this.startingAt = Date.parse(line.slice(0, 19).replace(' ', 'T')) || Date.now(); continue; }
      let m = SIDE_OFFERED.exec(line);
      if (m) { this.offers.set(m[2], { task: m[2], desktopId: m[3], at: Date.parse(m[1].replace(' ', 'T')) || Date.now() }); continue; }
      m = SIDE_OFFER_DONE.exec(line);
      if (m) { this.offers.delete(m[1] || m[2] || m[3]); continue; }
      m = TRUST_CHECKED.exec(line);
      if (m) { this.trustChecks.set(folderKey(m[2]), { folder: m[2], at: Date.parse(m[1].replace(' ', 'T')) || Date.now() }); continue; }
      m = TRUST_SAVED.exec(line);
      if (m) { this.trustChecks.delete(folderKey(m[1])); continue; }
      m = PERMISSION_EMITTED.exec(line);
      if (m) { this.pending.set(m[2], { requestId: m[2], tool: m[3], desktopId: m[4], at: Date.parse(m[1].replace(' ', 'T')) || Date.now() }); continue; }
      m = PERMISSION_ABORTED.exec(line);
      if (m) { this.pending.delete(m[1]); continue; }
      m = PERMISSION_RECEIVED.exec(line);
      if (m) {
        const answered = this.pending.get(m[1]);
        this.pending.delete(m[1]);
        // The desktop puts a session's prompts up one at a time, oldest first:
        // a later one answered means an older one is gone, cancelled or
        // interrupted without a response line (seen: one left "waiting" for
        // 11 hours after a later prompt of the same session was answered).
        if (answered) for (const [id, item] of this.pending) if (item.desktopId === answered.desktopId && item.at <= answered.at) this.pending.delete(id);
      }
    }
  }

  // Sessions with a suggested side session still on screen: desktopId -> { task, at }.
  offersBySession(now = Date.now()) {
    const out = new Map();
    for (const item of this.offers.values()) {
      if (now - item.at > PENDING_MAX_AGE_MS) continue;
      const prior = out.get(item.desktopId);
      if (!prior || item.at > prior.at) out.set(item.desktopId, item);
    }
    return out;
  }

  // Folders checked for trust lately and not trusted since: a dialog may be up.
  recentTrustChecks(now = Date.now()) {
    return [...this.trustChecks.values()].filter((item) => now - item.at < TRUST_WINDOW_MS);
  }

  bySession(now) {
    const out = new Map();
    for (const item of this.pending.values()) {
      if (now - item.at > PENDING_MAX_AGE_MS) continue;
      const prior = out.get(item.desktopId);
      if (!prior || item.at > prior.at) out.set(item.desktopId, item);
    }
    return out;
  }
}

// ---- desktop session store -----------------------------------------------
// Permission values are the desktop's own (default / acceptEdits / plan /
// auto / bypassPermissions); older KH Link values are mapped on write.
const PERMISSION_TO_MODE = { bypassPermissions: 'bypassPermissions', acceptEdits: 'acceptEdits', auto: 'auto', default: 'default', plan: 'plan', dontAsk: 'default' };
const MODE_TO_PERMISSION = { ...PERMISSION_TO_MODE, yolo: 'bypassPermissions', manual: 'default' };

class ClaudeDesktopStore {
  constructor({ logFiles = null, root, projectsRoot = path.join(os.homedir(), '.claude', 'projects'), execFileFn = execFile, profileRegistryRoot, findRoot = claudeAppDir, findLogFiles = desktopLogFiles } = {}) {
    // Without a given root the folder is looked up again by relocate(), so a
    // desktop app installed after the connector started is still found.
    this.findRoot = root ? null : findRoot;
    this.findLogFiles = logFiles ? null : findLogFiles;
    this.root = root || findRoot();
    this.projectsRoot = projectsRoot;
    this.execFileFn = execFileFn;
    this.profileRegistryRoot = profileRegistryRoot;
    this.metaCache = new Map(); // file -> { mtimeMs, meta }
    // plan-usage-history.json is rewritten by the desktop app. A poll can
    // catch the file between truncate/rename (or during a partial JSON write);
    // retain the last complete sample for that short interval so the phone
    // does not fall back to an older command-line event and flash bad usage.
    this.usageSampleCache = null;
    this.permissionLog = new DesktopPermissionLog(logFiles || findLogFiles(this.root));
  }

  // Point the store at the desktop app's folder if it has appeared since the
  // store was made (Store installs keep it under a per-package folder that
  // does not exist before installing). True when the folder changed.
  relocate() {
    if (!this.findRoot) return false;
    const root = this.findRoot();
    if (!root || root === this.root || !fs.existsSync(path.join(root, 'claude-code-sessions'))) return false;
    this.root = root; this.metaCache.clear(); this.usageSampleCache = null;
    this.officialUsageCache = null;
    if (this.findLogFiles) this.permissionLog = new DesktopPermissionLog(this.findLogFiles(root));
    return true;
  }

  // Sessions the desktop is currently waiting on (unanswered prompts).
  pendingPrompts(now) { return this.permissionLog.poll(now); }
  // Read after pendingPrompts(), which reads the log.
  pendingOffers(now) { return this.permissionLog.offersBySession(now); }
  pendingTrustChecks(now) { return this.permissionLog.recentTrustChecks(now); }
  // When the running desktop app started (0 = unknown); its unread dots only
  // cover activity since then.
  appStartedAt() { return this.permissionLog.appStartedAt; }

  available() { return fs.existsSync(path.join(this.root, 'claude-code-sessions')); }

  // The signed-in account's folder is the one holding the most recently
  // written session file (other folders belong to past accounts/orgs).
  accountDir() {
    const registered = require('./claude-profile-lock').registeredAccountDir(this.root, this.profileRegistryRoot);
    this.managedProfile = registered !== undefined;
    if (registered !== undefined) return registered;
    const base = path.join(this.root, 'claude-code-sessions'); let best = null;
    try {
      for (const account of fs.readdirSync(base)) {
        for (const org of fs.readdirSync(path.join(base, account))) {
          const dir = path.join(base, account, org);
          for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
            if (!best || mtimeMs > best.mtimeMs) best = { dir, mtimeMs };
          }
        }
      }
    } catch { /* partial tree */ }
    return best?.dir || null;
  }

  readSessions() {
    this.sessionScanComplete = false;
    const dir = this.accountDir(); if (!dir) return [];
    this.sessionSource = dir;
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    this.sessionScanComplete = true;
    const sessions = [];
    for (const name of names) {
      if (!/^local_[\w-]+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const { mtimeMs } = fs.statSync(file); const cached = this.metaCache.get(file);
        const meta = cached && cached.mtimeMs === mtimeMs ? cached.meta : JSON.parse(fs.readFileSync(file, 'utf8'));
        this.metaCache.set(file, { mtimeMs, meta });
        if (!meta.sessionId || !meta.cliSessionId) { this.sessionScanComplete = false; continue; }
        sessions.push({
          desktopId: meta.sessionId, cliSessionId: meta.cliSessionId, cwd: meta.cwd || meta.originCwd || '',
          title: meta.title || '', model: meta.model || '', effort: meta.effort || '',
          approveMode: PERMISSION_TO_MODE[meta.permissionMode] || 'default',
          archived: !!meta.isArchived, starred: !!meta.isStarred,
          createdAt: meta.createdAt || 0, updatedAt: meta.lastActivityAt || meta.createdAt || mtimeMs, focusedAt: meta.lastFocusedAt || 0,
          // The desktop's own classification of the last finished turn. Only
          // trusted when it summarises the latest assistant message.
          turnSummary: meta.postTurnSummary && typeof meta.postTurnSummary === 'object' ? {
            category: String(meta.postTurnSummary.status_category || ''),
            detail: String(meta.postTurnSummary.status_detail || ''),
            needsAction: String(meta.postTurnSummary.needs_action || ''),
            current: !!meta.lastAssistantUuid && (meta.postTurnSummaryFor || meta.postTurnSummary.summarizes_uuid) === meta.lastAssistantUuid,
          } : null,
          // Who the last turn answers. A session started by another session
          // hands its turn report to that session; a session woken by its
          // side sessions since the user last wrote is summarising them.
          spawned: !!meta.spawnedFrom,
          turnReported: typeof meta.lastTurnReport === 'string' && meta.lastTurnReport.length > 0,
          sideWakes: Number(meta.sideSessionWakesSinceUserMessage) || 0,
        });
      } catch { this.sessionScanComplete = false; /* being rewritten by the app, not deleted */ }
    }
    return sessions;
  }

  // Sidebar pin order, e.g. ["local_…", …] from the app's persisted store.
  // The sidebar's unread dots, exactly as the desktop keeps them (read-only).
  // null when the store cannot be read, so callers can fall back.
  readUnreadIds() {
    const entries = readLocalStorage(path.join(this.root, 'Local Storage', 'leveldb'), '"unreadIds"');
    let best = null;
    for (const [key, entry] of entries) {
      if (!/epitaxy-unread/.test(key)) continue;
      if (!best || entry.seq > best.seq) best = entry;
    }
    if (!best) return null;
    try {
      const state = JSON.parse(best.text).state || {};
      return new Set([...(state.unreadIds || []), ...(state.explicitUnreadIds || [])].filter((id) => /^local_/.test(id)));
    } catch { return null; }
  }

  readPinnedOrder() {
    const entries = readLocalStorage(path.join(this.root, 'Local Storage', 'leveldb'), '"pinnedOrder"');
    let best = null;
    for (const [key, entry] of entries) {
      if (!/dframe/.test(key)) continue;
      if (!best || entry.seq > best.seq) best = entry;
    }
    if (!best) return [];
    const match = /"pinnedOrder":(\[[^\]]*\])/.exec(best.text);
    if (!match) return [];
    try { return JSON.parse(match[1]).map((id) => String(id).replace(/^code:/, '')).filter((id) => id.startsWith('local_')); } catch { return []; }
  }

  // Sessions merged with pin state. `pinOrder` follows the sidebar.
  listSessions() {
    const order = this.readPinnedOrder(); const rank = new Map(order.map((id, index) => [id, index]));
    return this.readSessions().map((session) => {
      const pinned = session.starred;
      return { ...session, pinned, pinOrder: pinned ? (rank.has(session.desktopId) ? rank.get(session.desktopId) : 10_000) : -1 };
    });
  }

  // Use the same passive reader/selector as the desktop account panel. Unknown
  // managed identity and an in-progress switch return an empty managed result,
  // never `undefined` (which would permit the legacy/CLI fallback).
  latestOfficialUsage(now = Date.now(), { force = false } = {}) {
    const lock = require('./claude-profile-lock');
    const identity = () => lock.registeredProfile(this.root, this.profileRegistryRoot);
    const active = identity();
    if (active === undefined) return undefined;
    const unavailable = () => { this.officialUsageCache = null; return { org: null, usage: null, accountState: lock.switching(this.profileRegistryRoot) ? 'switching' : 'unavailable' }; };
    if (!active || lock.switching(this.profileRegistryRoot)) return unavailable();
    const key = `${active.profile}\0${active.org}`;
    if (force || this.officialUsageCache?.key !== key || now - this.officialUsageCache.readAt >= 5000 || now < this.officialUsageCache.readAt) {
      // All suffixes below are fixed or registry-validated. Reject reparse
      // points throughout the data paths, including hints, before opening them.
      const guarded = relative => {
        const root = path.resolve(active.root);
        if (fs.realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error('Invalid usage root');
        let current = root;
        for (const part of relative.split(/[\\/]/)) {
          current = path.join(current, part);
          try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Invalid usage path'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        return current;
      };
      let usage = null;
      try {
        usage = require('./claude-desktop-usage').readOfficialUsage({ org: active.org, alias: active.alias,
          historyFile: guarded(path.join('profiles', active.alias, 'plan-usage-history.json')),
          callbackFile: guarded(path.join('usage', active.alias + '.json')),
          cacheDir: guarded(path.join('profiles', active.alias, 'Cache/Cache_Data')),
          hintFile: guarded(path.join('usage', active.alias + '-mobile-cache-address.json')),
          observationsDir: guarded(path.join('usage', active.alias + '-official-observations')),
        }, now);
      } catch { /* Unsupported or moving files cannot supply a quota. */ }
      this.officialUsageCache = { key, usage, readAt: now };
    }
    const after = identity();
    if (!after || after.profile !== active.profile || after.org !== active.org || lock.switching(this.profileRegistryRoot)) return unavailable();
    return { org: active.org, profileAlias: active.alias, usage: this.officialUsageCache.usage, accountState: 'ready',
      accountFingerprint: require('../account-identity').accountIdentity('claude-profile', `${active.profile}\0${active.accountDir}`) };
  }

  profileSignature() {
    const lock = require('./claude-profile-lock');
    const active = lock.registeredProfile(this.root, this.profileRegistryRoot);
    if (active === undefined) return undefined;
    if (lock.switching(this.profileRegistryRoot)) return 'switching';
    return active ? `${active.profile}\0${active.accountDir}` : 'unavailable';
  }

  resetProfileCaches() {
    this.metaCache.clear(); this.usageSampleCache = null; this.officialUsageCache = null;
    // The linked path stays the same, but the new profile's log has its own
    // byte offsets and pending permission prompts.
    if (this.findLogFiles) this.permissionLog = new DesktopPermissionLog(this.findLogFiles(this.root));
  }

  // Latest plan-usage sample the desktop app records every ~15 minutes for the
  // signed-in organisation: { at, fiveHour, sevenDay } as used fractions 0..1.
  latestUsageSample(now = Date.now()) {
    const account = this.accountDir();
    if (this.managedProfile && !account) { this.usageSampleCache = null; this.usageOrg = null; return null; }
    const org = account ? path.basename(account) : null;
    this.usageOrg = org;
    if (org && this.usageSampleCache?.org && this.usageSampleCache.org !== org) this.usageSampleCache = null;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.root, 'plan-usage-history.json'), 'utf8'));
      const samples = (data.samples || []).filter((sample) => sample?.u && Number.isFinite(sample.t) && sample.t > 0 && sample.t <= now + 5 * 60_000 && (!org || (!this.managedProfile && !sample.org) || sample.org === org));
      const last = samples.reduce((best, sample) => !best || sample.t > best.t ? sample : best, null);
      if (!last) return this.usageSampleCache;
      const sampleOrg = last.org || org || null;
      if (this.usageSampleCache?.org && this.usageSampleCache.org !== sampleOrg) this.usageSampleCache = null;
      const result = { org: sampleOrg };
      for (const [key, short] of [['fiveHour', 'fh'], ['sevenDay', 'sd']]) {
        const latest = samples.filter((row) => (!row.org || row.org === sampleOrg) && Number.isFinite(row.u[short]) && row.u[short] >= 0 && row.u[short] <= 100)
          .reduce((best, row) => !best || row.t > best.t ? row : best, null);
        const cachedAt = this.usageSampleCache?.[`${key}ObservedAt`] || 0;
        // A partial or older rewrite cannot erase/re-date the other window.
        result[key] = latest && latest.t >= cachedAt ? latest.u[short] / 100 : this.usageSampleCache?.[key] ?? null;
        result[`${key}ObservedAt`] = latest && latest.t >= cachedAt ? latest.t : cachedAt || null;
      }
      result.at = Math.max(result.fiveHourObservedAt || 0, result.sevenDayObservedAt || 0);
      // No exact reset timestamps in the samples; the restart brackets let the
      // usage state estimate them (see claude-usage.js).
      result.fiveHourResetsAt = null; result.sevenDayResetsAt = null;
      const brackets = usageResetBrackets(samples.filter((row) => !row.org || row.org === sampleOrg));
      result.fiveHourResetBracket = brackets.fiveHour; result.sevenDayResetBracket = brackets.sevenDay;
      this.usageSampleCache = result.at ? result : this.usageSampleCache;
      return this.usageSampleCache;
    } catch {
      return this.usageSampleCache;
    }
  }

  // The session the desktop window most recently focused (to switch back to).
  focusedSessionId() {
    let best = null;
    for (const session of this.readSessions()) if (!best || session.focusedAt > best.focusedAt) best = session;
    return best?.desktopId || null;
  }

  transcriptFor(session) { return transcriptPath(session.cwd, session.cliSessionId, this.projectsRoot); }

  // cliSessionIds that a desktop-app Claude process currently holds. Writing
  // to such a session from the phone would fork the conversation, so callers
  // must refuse while it is open on the desktop.
  liveDesktopSessions() {
    if (process.platform !== 'win32') return Promise.resolve(new Set());
    const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { $_.ExecutablePath + '|' + $_.CommandLine }";
    return new Promise((resolve) => {
      this.execFileFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        const live = new Set();
        // A failed query (timed out while the PC was busy) knows nothing: it
        // must not read as "the desktop app is closed".
        if (error) live.failed = true;
        if (!error) {
          for (const line of String(stdout || '').split(/\r?\n/)) {
            const [exe = '', cmd = ''] = line.split('|');
            // The desktop app itself (its main process, not a --type= helper).
            if (/\\WindowsApps\\Claude_[^\\]*\\app\\claude\.exe$/i.test(exe) && !/--type=/i.test(cmd)) live.appRunning = true;
            if (!isDesktopClaudeBinaryPath(exe)) continue; // official installed or managed profile binaries
            const ids = [...line.matchAll(/--(?:resume|session-id)[= ]"?([0-9a-f-]{36})/gi)];
            if (!ids.length) live.unattributed = true; // Could be a child/background task; never assume idle.
            for (const m of ids) live.add(m[1]);
          }
        }
        resolve(live);
      });
    });
  }

  // Ask the desktop app to import a Claude Code session through its own
  // claude://resume deep link (the app's official "import CLI session" path).
  // It shows up in the sidebar at once; the window then switches back to the
  // session the user was on.
  importSession(cliSessionId, restoreDesktopId = null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(cliSessionId || ''))) return Promise.resolve(false);
    const restore = /^local_[0-9a-f-]{36}$/.test(String(restoreDesktopId || '')) ? restoreDesktopId : '';
    const script = `Start-Process 'claude://resume?session=${cliSessionId}'${restore ? `; Start-Sleep -Milliseconds 3500; Start-Process 'claude://claude.ai/epitaxy/${restore}'` : ''}`;
    return new Promise((resolve) => {
      this.execFileFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (error) => resolve(!error));
    });
  }

  // Legacy: write a session file directly. The running app only reads its
  // folder at start-up, so importSession() is preferred.
  registerSession({ cliSessionId, cwd, title, model, effort, approveMode, createdAt = Date.now(), desktopId } = {}) {
    const dir = this.accountDir(); if (!dir || !cliSessionId) return null;
    const id = desktopId || `local_${crypto.randomUUID()}`;
    const file = path.join(dir, `${id}.json`);
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
    const meta = {
      ...existing, sessionId: id, cliSessionId, cwd, originCwd: existing.originCwd || cwd,
      createdAt: existing.createdAt || createdAt, lastActivityAt: Date.now(),
      model: model || existing.model || '', effort: effort || existing.effort || '',
      isArchived: false, title: title || existing.title || 'khLink 任务', titleSource: existing.titleSource || 'user',
      permissionMode: MODE_TO_PERMISSION[approveMode] || existing.permissionMode || 'default',
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(meta));
    fs.renameSync(temporary, file);
    return id;
  }
}

module.exports = {
  DesktopPermissionLog, claudeAppDir, realDesktopPath, ClaudeDesktopStore, findDesktopClaudeBin, probeModels, modelLabel, prettyModelId,
  transcriptItems, readTranscript, readTranscriptImage, peekTranscriptState, pendingToolUse, transcriptPath, projectDirName,
  START_SESSION_TOOL, OFFER_NEW, OFFER_HERE,
  readDesktopQueue: (file, maxBytes) => require('./claude-desktop-queue').readQueue(file, userText, maxBytes),
  snappyDecompress, tableEntries, logBatches, readLocalStorage,
  PERMISSION_TO_MODE, MODE_TO_PERMISSION,
};
