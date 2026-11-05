#!/usr/bin/env node
/*
 * Compare connector "-> completed" transitions with the terminal events in
 * Codex rollout JSONL files. This is deliberately offline: it never starts a
 * connector, reads credentials, or mutates a rollout. A completion is valid
 * only when the latest turn start for that thread already has a terminal
 * event (task_complete, turn_aborted/cancelled/interrupted, or an explicit
 * error termination) at or before the connector log timestamp. The reverse
 * check catches a stale watcher range that reopens a completed turn: a
 * completed -> running transition is valid only when a newer task start (or
 * real user message) precedes it and that turn has not already terminated.
 *
 * Example:
 *   node scripts/compare-completions.js \
 *     --log-dir "$APPDATA/FengzhuAgentBridge/logs" \
 *     --rollout-root "$USERPROFILE/.codex/sessions" \
 *     --since "2026-10-06 13:00:00" --until "2026-10-06 13:30:00"
 */

const fs = require('node:fs');
const path = require('node:path');
const { JsonLineReader } = require('../src/json-line-reader');

const START_TYPES = new Set(['task_started', 'user_message']);
const TERMINAL_TYPES = new Set(['task_complete', 'turn_aborted', 'turn_cancelled', 'turn_interrupted', 'task_failed', 'turn_failed', 'error', 'failed', 'fatal_error', 'stream_error']);

function usage() {
  console.error('Usage: node scripts/compare-completions.js --log FILE [--log FILE ...] --rollout-root DIR [--since DATE] [--until DATE] [--json]');
  process.exitCode = 2;
}

function args(argv) {
  const out = { logs: [], rolloutRoot: null, since: null, until: null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--log' && argv[i + 1]) out.logs.push(argv[++i]);
    else if (value === '--log-dir' && argv[i + 1]) out.logDir = argv[++i];
    else if (value === '--rollout-root' && argv[i + 1]) out.rolloutRoot = argv[++i];
    else if (value === '--since' && argv[i + 1]) out.since = Date.parse(argv[++i]);
    else if (value === '--until' && argv[i + 1]) out.until = Date.parse(argv[++i]);
    else if (value === '--json') out.json = true;
    else return null;
  }
  if (out.logDir) {
    try { out.logs.push(...fs.readdirSync(out.logDir).filter((name) => /^connector-.*\.log$/i.test(name)).map((name) => path.join(out.logDir, name))); } catch {}
  }
  out.logs = [...new Set(out.logs)].filter((file) => fs.existsSync(file));
  if (!out.logs.length || !out.rolloutRoot || (out.since !== null && !Number.isFinite(out.since)) || (out.until !== null && !Number.isFinite(out.until))) return null;
  return out;
}

function timestamp(value) {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? at : 0;
}

function logTime(line) {
  // Connector logs use the host's local time (no timezone suffix). Date.parse
  // therefore applies the same Windows timezone that produced the log.
  const match = String(line).match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)/);
  return match ? timestamp(match[1]) : 0;
}

function collectCompletions(files, since, until) {
  const rows = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const at = logTime(line);
      if (!at || (since !== null && at < since) || (until !== null && at > until)) continue;
      const match = line.match(/\bstatus\s+([0-9a-f]{8,36})\s+\S+\s+->\s+completed\b/i);
      if (!match) continue;
      rows.push({ at, threadPrefix: match[1].toLowerCase(), log: file, line: line.trim() });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function collectRunningTransitions(files, since, until) {
  const rows = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const at = logTime(line);
      if (!at || (since !== null && at < since) || (until !== null && at > until)) continue;
      const match = line.match(/\bstatus\s+([0-9a-f]{8,36})\s+completed\s+->\s+(?:(?:desktop|mobile)_)?running(?:\b|\s)/i);
      if (!match) continue;
      rows.push({ at, threadPrefix: match[1].toLowerCase(), log: file, line: line.trim() });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function rolloutId(file) {
  const name = path.basename(file);
  const match = name.match(/rollout-[^/\\]*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/i);
  return match?.[1]?.toLowerCase() || null;
}

function filesUnder(root) {
  const result = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (/^rollout-.*\.jsonl$/i.test(entry.name) && rolloutId(target)) result.push(target);
    }
  }
  return result;
}

function readTurns(file) {
  const turns = []; let current = null;
  // Production rollouts with generated images can exceed V8's maximum
  // string length (one observed file is 1.69 GB). Task markers are small;
  // stream them and discard huge image/tool payloads without buffering them.
  const reader = new JsonLineReader({ maxBytes: 64 * 1024, onLine: (line) => {
    let record; try { record = JSON.parse(line); } catch { return; }
    const payload = record?.payload || {};
    const type = String(payload.type || '').toLowerCase();
    const at = timestamp(record.timestamp);
    if (!at) return;
    if (record.type === 'event_msg' && START_TYPES.has(type)) {
      current = { startAt: at, terminalAt: 0, terminalType: null };
      turns.push(current);
      return;
    }
    if (record.type === 'event_msg' && (TERMINAL_TYPES.has(type) || (type === 'task_complete' && (payload.error || payload.failure)))) {
      if (!current || current.terminalAt) {
        // A terminal event without a start still belongs to a historical
        // rollout. Keep it available, but it cannot validate a later turn.
        current = { startAt: 0, terminalAt: at, terminalType: type };
        turns.push(current);
      } else {
        current.terminalAt = at; current.terminalType = type;
      }
    }
  } });
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size; const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read) break; offset += read; reader.push(buffer.subarray(0, read));
    }
    reader.push('\n'); // parse a complete last record even without final LF
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return turns;
}

function indexRollouts(root, wantedPrefixes) {
  const index = new Map();
  const roots = [root];
  // A normal archive moves the same rollout out of sessions. Missing it must
  // not turn a previously verified completion into a false audit mismatch.
  if (path.basename(path.resolve(root)).toLowerCase() === 'sessions') {
    const archived = path.join(path.dirname(root), 'archived_sessions');
    if (fs.existsSync(archived)) roots.push(archived);
  }
  for (const file of roots.flatMap(filesUnder)) {
    const id = rolloutId(file); if (!id) continue;
    const prefix = id.slice(0, 8);
    if (wantedPrefixes && !wantedPrefixes.has(prefix)) continue;
    const rows = index.get(prefix) || [];
    rows.push({ file, id, turns: readTurns(file) });
    index.set(prefix, rows);
  }
  return index;
}

function findEvidence(row, candidates) {
  const matches = [];
  for (const candidate of candidates || []) {
    for (const turn of candidate.turns) {
      if (!turn.startAt || turn.startAt > row.at) continue;
      matches.push({ candidate, turn });
    }
  }
  matches.sort((a, b) => (b.turn.startAt - a.turn.startAt) || ((b.turn.terminalAt || 0) - (a.turn.terminalAt || 0)));
  const best = matches[0];
  if (!best) return { ok: false, reason: 'no task_started/user_message at or before completion log' };
  if (!best.turn.terminalAt) return { ok: false, reason: 'latest turn has no terminal event', file: best.candidate.file, startAt: best.turn.startAt };
  if (best.turn.terminalAt > row.at) return { ok: false, reason: 'terminal event is after connector completion', file: best.candidate.file, startAt: best.turn.startAt, terminalAt: best.turn.terminalAt };
  return { ok: true, file: best.candidate.file, startAt: best.turn.startAt, terminalAt: best.turn.terminalAt, terminalType: best.turn.terminalType };
}

function findReverseEvidence(row, candidates) {
  const matches = [];
  for (const candidate of candidates || []) {
    for (const turn of candidate.turns) {
      if (!turn.startAt || turn.startAt > row.at) continue;
      matches.push({ candidate, turn });
    }
  }
  matches.sort((a, b) => (b.turn.startAt - a.turn.startAt) || ((b.turn.terminalAt || 0) - (a.turn.terminalAt || 0)));
  const best = matches[0];
  if (!best) return { ok: false, reason: 'no newer task_started/user_message at or before running transition' };
  // The latest start is still the completed turn when its terminal marker is
  // already at or before the reactivation. The watcher therefore delivered
  // an older range and must be counted as a reverse mismatch.
  if (best.turn.terminalAt && best.turn.terminalAt <= row.at) {
    return {
      ok: false,
      reason: 'latest task_started/user_message already terminated before running transition',
      file: best.candidate.file,
      startAt: best.turn.startAt,
      terminalAt: best.turn.terminalAt,
      terminalType: best.turn.terminalType,
    };
  }
  return { ok: true, file: best.candidate.file, startAt: best.turn.startAt, terminalAt: best.turn.terminalAt || 0 };
}

function main() {
  const options = args(process.argv);
  if (!options) return usage();
  const completions = collectCompletions(options.logs, options.since, options.until);
  const runningTransitions = collectRunningTransitions(options.logs, options.since, options.until);
  const prefixes = new Set([...completions, ...runningTransitions].map((row) => row.threadPrefix));
  const index = indexRollouts(options.rolloutRoot, prefixes);
  const checked = completions.map((row) => ({ ...row, evidence: findEvidence(row, index.get(row.threadPrefix)) }));
  const checkedRunning = runningTransitions.map((row) => ({ ...row, evidence: findReverseEvidence(row, index.get(row.threadPrefix)) }));
  const mismatches = checked.filter((row) => !row.evidence.ok);
  const reverseMismatches = checkedRunning.filter((row) => !row.evidence.ok);
  const result = {
    logs: options.logs,
    rolloutRoot: options.rolloutRoot,
    since: options.since ? new Date(options.since).toISOString() : null,
    until: options.until ? new Date(options.until).toISOString() : null,
    completedTransitions: checked.length,
    matched: checked.length - mismatches.length,
    mismatches: mismatches.length,
    mismatchRate: checked.length ? mismatches.length / checked.length : 0,
    runningTransitions: checkedRunning.length,
    reverseMismatches: reverseMismatches.length,
    reverseMismatchRate: checkedRunning.length ? reverseMismatches.length / checkedRunning.length : 0,
    details: mismatches.slice(0, 100).map(({ at, threadPrefix, line, evidence }) => ({ at: new Date(at).toISOString(), threadPrefix, line, ...evidence })),
    reverseDetails: reverseMismatches.slice(0, 100).map(({ at, threadPrefix, line, evidence }) => ({ at: new Date(at).toISOString(), threadPrefix, line, ...evidence })),
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`completed transitions: ${result.completedTransitions}`);
    console.log(`matched terminal events: ${result.matched}`);
    console.log(`mismatches: ${result.mismatches} (${(result.mismatchRate * 100).toFixed(2)}%)`);
    for (const detail of result.details) console.log(`${detail.at} ${detail.threadPrefix}: ${detail.reason}`);
    console.log(`completed -> running transitions: ${result.runningTransitions}`);
    console.log(`reverse mismatches: ${result.reverseMismatches} (${(result.reverseMismatchRate * 100).toFixed(2)}%)`);
    for (const detail of result.reverseDetails) console.log(`${detail.at} ${detail.threadPrefix}: ${detail.reason}`);
  }
  if (mismatches.length || reverseMismatches.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { collectCompletions, collectRunningTransitions, readTurns, findEvidence, findReverseEvidence, indexRollouts, rolloutId };
