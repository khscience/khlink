// Read-only view of Google Antigravity conversations, from the files the
// desktop app keeps under ~/.gemini/antigravity:
//
//   conversations/<id>.db   SQLite; table `steps` holds one protobuf message per
//                           agent step (user input, model reply, tool call, ...)
//   annotations/<id>.pbtxt  title and the time the user last viewed it
//
// Nothing here talks to Antigravity or Google (messages from the phone go
// through its window, see antigravity-sync.js). The step layout below was read
// from these local files (field numbers are stable across the conversations
// on this machine).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STEP_USER = 14;
const STEP_MODEL = 15;
const STEP_ERROR = 17;
const STEP_SUBTASK_MESSAGE = 101;
const STEP_TOOL = 132;
// CortexStepStatus from the installed official language_server.exe descriptor:
// 1 pending, 2 running, 3 done, 4 invalid, 5 cleared, 6 canceled, 7 error,
// 8 generating, 9 waiting, 10 halted, 11 queued, 12 interrupted. In particular,
// a live streamed reply moves 8 -> 3; 8 must never mean "stopped".
const STATUS_RUNNING = 2;
const STATUS_WAITING = 9;
const STATUS_ACTIVE = new Set([1, 2, 8, 11]);
const STATUS_FAILED = new Set([4, 7]);
const STATUS_STOPPED = new Set([6, 10, 12]);

function stepState(status) {
  if (STATUS_ACTIVE.has(status) || status === STATUS_WAITING) return 'inProgress';
  if (STATUS_FAILED.has(status)) return 'failed';
  if (STATUS_STOPPED.has(status)) return 'interrupted';
  return 'completed';
}

function antigravityHome() {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

// ---- minimal protobuf wire decoding --------------------------------------
function readVarint(buffer, offset) {
  let result = 0; let shift = 0; let index = offset;
  for (;;) {
    if (index >= buffer.length) throw new RangeError('truncated varint');
    const byte = buffer[index++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, index];
    shift += 7;
    if (shift > 63) throw new RangeError('varint too long');
  }
}

// Returns [{ field, wire, value }] (value: number or Buffer), or null when the
// bytes are not a well-formed message.
function decodeMessage(buffer) {
  const fields = []; let index = 0;
  try {
    while (index < buffer.length) {
      let key; [key, index] = readVarint(buffer, index);
      const field = Math.floor(key / 8); const wire = key % 8;
      if (field === 0) return null;
      if (wire === 0) { let value; [value, index] = readVarint(buffer, index); fields.push({ field, wire, value }); }
      else if (wire === 1) { index += 8; fields.push({ field, wire, value: null }); }
      else if (wire === 5) { index += 4; fields.push({ field, wire, value: null }); }
      else if (wire === 2) {
        let length; [length, index] = readVarint(buffer, index);
        if (index + length > buffer.length) return null;
        fields.push({ field, wire, value: buffer.subarray(index, index + length) }); index += length;
      } else return null;
      if (index > buffer.length) return null;
    }
    return fields;
  } catch { return null; }
}

// Walk a path of field numbers; returns the first matching raw value.
function pick(buffer, ...pathFields) {
  let current = buffer;
  for (let depth = 0; depth < pathFields.length; depth += 1) {
    if (!Buffer.isBuffer(current)) return undefined;
    const fields = decodeMessage(current); if (!fields) return undefined;
    const hit = fields.find((entry) => entry.field === pathFields[depth]);
    if (!hit) return undefined;
    current = hit.value;
  }
  return current;
}

function pickAll(buffer, field) {
  const fields = Buffer.isBuffer(buffer) ? decodeMessage(buffer) : null;
  return fields ? fields.filter((entry) => entry.field === field).map((entry) => entry.value) : [];
}

function text(value) { return Buffer.isBuffer(value) ? value.toString('utf8') : ''; }

function timestampMs(buffer) {
  const seconds = pick(buffer, 1); const nanos = pick(buffer, 2);
  return typeof seconds === 'number' ? seconds * 1000 + Math.floor((typeof nanos === 'number' ? nanos : 0) / 1e6) : null;
}

function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }

// ---- step -> KH Link history item ----------------------------------------
const FILE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'create_file', 'edit_file', 'delete_file']);
const SEARCH_TOOLS = new Set(['search_web', 'read_url_content', 'web_search']);

function toolItem(call, status, reason = '') {
  const name = text(pick(call, 2)) || 'tool';
  const args = parseJson(text(pick(call, 3))) || {};
  const summary = [args.toolSummary || args.toolAction || '', reason].filter(Boolean).join('\n');
  const state = stepState(status);
  if (name === 'run_command') {
    return { type: 'commandExecution', text: [args.CommandLine || args.command || '', summary].filter(Boolean).join('\n\n') || '命令', status: state };
  }
  if (FILE_TOOLS.has(name)) {
    const file = args.TargetFile || args.AbsolutePath || args.path || '';
    const verb = name === 'write_to_file' || name === 'create_file' ? '新增' : name === 'delete_file' ? '删除' : '修改';
    return { type: 'fileChange', text: [file ? `${verb} ${file}` : '', summary].filter(Boolean).join('\n') || '文件变更', status: state };
  }
  if (SEARCH_TOOLS.has(name)) return { type: 'webSearch', text: args.query || args.Url || args.url || summary || '网络搜索', status: state };
  const target = args.AbsolutePath || args.DirectoryPath || args.SearchPath || args.Query || args.Pattern || '';
  return { type: 'mcpToolCall', text: [name, summary || target].filter(Boolean).join('\n'), status: state };
}

// ask_question: {"questions":[{"question","options":[...],"is_multi_select"}]}
function askQuestions(call) {
  const args = parseJson(text(pick(call, 3))) || {};
  return (Array.isArray(args.questions) ? args.questions : []).map((question) => ({
    question: String(question?.question || ''), header: '', multiSelect: Boolean(question?.is_multi_select),
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({ label: String(option), description: '' })),
  })).filter((question) => question.question);
}

// What a step waiting for the user asks, in the shape the phone's waiting
// card reads (as for Codex and Claude); null when the step is not waiting.
function waitingFor(row) {
  if (!row || row.status !== STATUS_WAITING) return null;
  const payload = Buffer.from(row.step_payload || []);
  const call = pick(payload, 5, 4) || pick(payload, 4);
  const tool = Buffer.isBuffer(call) ? text(pick(call, 2)) : '';
  const requestId = (Buffer.isBuffer(call) && text(pick(call, 1))) || `ag-${row.idx}`;
  if (tool === 'ask_question') {
    const questions = askQuestions(call);
    const first = questions[0]?.question || '';
    // Answered from the phone through the app's own option buttons (antigravity-send.ps1 -Mode answer).
    return { kind: 'question', tool, requestId, summary: first ? `反重力在问你：${first.slice(0, 60)}` : '反重力在等你回答', description: '', questions, answerable: questions.length > 0 };
  }
  const args = Buffer.isBuffer(call) ? (parseJson(text(pick(call, 3))) || {}) : {};
  return { kind: 'approval', tool: tool || 'step', requestId, summary: '反重力在等你确认', description: String(args.CommandLine || args.toolSummary || args.toolAction || tool || ''), questions: [], answerable: false };
}

// One step can become several items (a reply with text and thinking).
function stepItems(row) {
  const payload = Buffer.from(row.step_payload || []);
  const at = timestampMs(pick(payload, 5, 1)) || null;
  const items = [];
  const push = (suffix, value) => { if (value && String(value.text || '').trim()) items.push({ id: `ag-${row.idx}${suffix}`, at, value }); };
  if (row.step_type === STEP_USER) {
    push('', { type: 'userMessage', text: text(pick(payload, 19, 2)) || text(pick(payload, 19, 3, 1)), status: null });
  } else if (row.step_type === STEP_MODEL) {
    push('-think', { type: 'reasoning', text: text(pick(payload, 20, 3)), status: null });
    push('', { type: 'agentMessage', text: text(pick(payload, 20, 1)), status: STATUS_STOPPED.has(row.status) ? 'interrupted' : null });
  } else if (row.step_type === STEP_TOOL) {
    // The call sits in the step header (5.4); older builds put it at 4.
    const call = pick(payload, 5, 4) || pick(payload, 4);
    if (Buffer.isBuffer(call) && text(pick(call, 2)) === 'ask_question') {
      // The question and, once given, the answer ("A1: <option>").
      const asked = askQuestions(call).map((question) => question.question).join('\n');
      // Only a finished step holds the answer; while waiting the field says so instead.
      const answer = row.status === 3 || row.status === 5 ? text(pick(payload, 140, 2, 1)) : '';
      push('', { type: 'mcpToolCall', text: ['提问', [asked, answer && `回答：${answer.replace(/^A\d+:\s*/, '')}`].filter(Boolean).join('\n')].join('\n'), status: stepState(row.status) });
      return items;
    }
    // Why a call was refused before it ran (e.g. missing arguments).
    const reason = STATUS_FAILED.has(row.status) ? text(pick(payload, 31, 2)) : '';
    // Stopped by the user (Stop Task / Cancel): "context canceled" in the result.
    const canceled = row.status === 6 && /\bcancel(l)?ed\b/i.test(text(pick(payload, 140, 2, 6, 2, 31, 2)) || reason);
    if (Buffer.isBuffer(call) && text(pick(call, 2))) {
      const item = toolItem(call, row.status, canceled ? '' : reason);
      if (canceled) item.status = 'interrupted';
      push('', item);
    }
  } else if (row.step_type === STEP_ERROR) {
    // Retries ("API error (attempt 1): ...") are noise; the final "Agent
    // execution terminated" notice carries a headline in 24.3.1.
    const headline = text(pick(payload, 24, 3, 1));
    const detail = text(pick(payload, 24, 3, 9)) || text(pick(payload, 24, 3, 2));
    if (headline || !/^API error \(attempt \d+\)/i.test(detail)) {
      push('', { type: 'error', text: [headline, detail.split(/\r?\n/)[0].slice(0, 300)].filter(Boolean).join('\n'), status: 'failed' });
    }
  } else if (row.step_type === STEP_SUBTASK_MESSAGE) {
    // "[Message] timestamp=... sender=<conv>/task-53 ... content=<text>"
    const raw = text(pick(payload, 114, 1));
    const content = raw.match(/content=([\s\S]*)$/)?.[1]?.trim() || '';
    const title = text(pick(payload, 114, 2, 1)) || content.split(/\r?\n/)[0].slice(0, 120);
    push('', { type: 'collabAgentToolCall', text: title, status: 'completed' });
  }
  return items;
}

// ---- conversation metadata --------------------------------------------------
// The sync looks at every conversation's annotation every few seconds. Reading
// all of them each time cost seconds of blocked thread while the PC was busy;
// a file whose size and time have not changed is not read again.
const annotationCache = new Map(); // file -> { mtimeMs, size, value }

function readAnnotation(home, id) {
  const file = path.join(home, 'annotations', `${id}.pbtxt`);
  let stat; try { stat = fs.statSync(file); } catch { annotationCache.delete(file); return {}; }
  const cached = annotationCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const title = raw.match(/title:"((?:[^"\\]|\\.)*)"/)?.[1];
  const viewed = raw.match(/last_user_view_time:\{seconds:(\d+)/)?.[1];
  const value = { title: title ? title.replace(/\\(.)/g, '$1') : '', viewedAt: viewed ? Number(viewed) * 1000 : 0 };
  annotationCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function workspaceFromUri(uri) {
  if (!uri || !/^file:\/\//i.test(uri)) return '';
  try {
    const decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/i, ''));
    return decoded.replace(/\//g, '\\').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
  } catch { return ''; }
}

let sqliteModule = null;
function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  // node:sqlite prints a one-time ExperimentalWarning, which the connector's
  // file log would record as an error; drop just that warning.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite is an experimental feature/i.test(String(warning?.message || warning))) return;
    emit.call(process, warning, ...rest);
  };
  try { sqliteModule = require('node:sqlite'); } finally { process.emitWarning = emit; }
  return sqliteModule;
}

// The model of the latest request (e.g. "gemini-3.8-flash-high"): gen_metadata
// holds one record per model call, the id at field 3.28. Only that field is read.
function latestModel(db) {
  const row = db.prepare('select data from gen_metadata order by idx desc limit 1').get();
  const value = row?.data ? text(pick(Buffer.from(row.data), 3, 28)) : '';
  return /^[\w.\-\/]{1,80}$/.test(value) ? value : '';
}

function readModel(file) {
  const db = openReadOnly(file);
  try { return latestModel(db); } catch { return ''; } finally { db.close(); }
}

function openReadOnly(file) {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(file, { readOnly: true });
}

function normalizeSendText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

// Confirm a send only against a new user step in the intended conversation.
// An identical message from an older turn is not an acceptance receipt.
function readSendState(file, message = '', afterIdx = -1) {
  const db = openReadOnly(file);
  try {
    const lastIdx = db.prepare('select max(idx) as idx from steps').get()?.idx ?? -1;
    let receipt = null;
    if (message) {
      const rows = db.prepare('select idx, step_type, status, step_payload from steps where step_type = ? and idx > ? order by idx').all(STEP_USER, afterIdx);
      for (const row of rows) {
        const item = stepItems(row).find((item) => item.value.type === 'userMessage');
        if (item && normalizeSendText(item.value.text) === normalizeSendText(message)) { receipt = { idx: row.idx, at: item.at }; break; }
      }
    }
    return { lastIdx, receipt };
  } finally { db.close(); }
}

// Everything the phone needs from one conversation file. `afterIdx` limits
// the steps read to new ones (plus a couple before, which may still change);
// `openIdx` is the first step last seen in progress, read again until it ends.
function readConversation(file, afterIdx = -1, openIdx = null) {
  const db = openReadOnly(file);
  try {
    const metaRow = db.prepare('select data from trajectory_metadata_blob limit 1').get();
    const meta = metaRow?.data ? Buffer.from(metaRow.data) : null;
    const createdAt = meta ? timestampMs(pick(meta, 2)) : null;
    const cwd = meta ? workspaceFromUri(text(pick(meta, 7))) : '';
    const last = db.prepare('select max(idx) as idx from steps').get()?.idx ?? -1;
    const from = Math.max(0, Math.min(afterIdx - 2, Number.isInteger(openIdx) ? openIdx : Infinity));
    const rows = db.prepare('select idx, step_type, status, step_payload from steps where idx >= ? order by idx').all(from);
    const items = rows.flatMap(stepItems);
    const open = rows.find((row) => STATUS_ACTIVE.has(row.status) || row.status === STATUS_WAITING)?.idx ?? null;
    const tail = db.prepare('select idx, step_type, status, step_payload from steps order by idx desc limit 1').get();
    const lastAt = tail ? timestampMs(pick(Buffer.from(tail.step_payload || []), 5, 1)) : null;
    const lastStatus = tail?.status ?? null;
    const lastType = tail?.step_type ?? null;
    const waiting = waitingFor(tail);
    let model = ''; try { model = latestModel(db); } catch { /* older files have no gen_metadata */ }
    const firstUser = db.prepare('select step_payload from steps where step_type = ? order by idx limit 1').get(STEP_USER);
    const firstText = firstUser ? text(pick(Buffer.from(firstUser.step_payload || []), 19, 2)) : '';
    return { createdAt, cwd, lastIdx: last, items, lastAt, lastStatus, lastType, openIdx: open, waiting, model, firstText };
  } finally { db.close(); }
}

module.exports = { loadSqlite, antigravityHome, decodeMessage, pick, pickAll, stepItems, toolItem, stepState, waitingFor, askQuestions, readAnnotation, workspaceFromUri, readConversation, readModel, readSendState, normalizeSendText, STEP_USER, STEP_MODEL, STEP_TOOL, STEP_ERROR, STATUS_RUNNING, STATUS_WAITING, STATUS_ACTIVE, STATUS_FAILED, STATUS_STOPPED };
