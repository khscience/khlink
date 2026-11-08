// Compacts khLink light-mode detail files: keeps only the last line of every
// row id (the reader scans from the end and uses the last one), so a file the
// connector re-appended after every restart shrinks back to one copy per row.
//
//   node ops/compact-light-details.mjs <light-details dir> <scratch dir> [--apply]
//
// Stop the connector first. Without --apply it only reports. With --apply each
// compacted file is written to the scratch dir, checked (same set of ids, the
// same last line per id), and only then replaces the original.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const [dir, scratch] = process.argv.slice(2, 4);
const apply = process.argv.includes('--apply');
if (!dir || !scratch) { console.error('usage: compact-light-details.mjs <dir> <scratch> [--apply]'); process.exit(2); }

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) fn(line, n++);
  return n;
}
const idOf = (line) => { try { const row = JSON.parse(line); return row && row.id != null ? String(row.id) : null; } catch { return null; } };
const digest = (line) => crypto.createHash('sha256').update(line).digest('hex');

fs.mkdirSync(scratch, { recursive: true });
let before = 0, after = 0;
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size })).sort((a, b) => a.size - b.size);
for (const { name, size } of files) {
  const file = path.join(dir, name);
  const last = new Map(); // id -> line number of its last copy
  const total = await eachLine(file, (line, n) => { const id = idOf(line); if (id !== null) last.set(id, n); });
  const keep = new Set(last.values());
  before += size;
  if (keep.size === total) { after += size; continue; } // nothing repeated
  const out = path.join(scratch, name);
  const writer = fs.createWriteStream(out);
  const expected = new Map(); // id -> digest of its last line
  await eachLine(file, (line, n) => { if (keep.has(n)) { writer.write(line + '\n'); expected.set(idOf(line), digest(line)); } });
  await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
  // Check: one line per id, each the same as the original's last copy.
  const seen = new Map();
  await eachLine(out, (line) => { seen.set(idOf(line), digest(line)); });
  const same = seen.size === expected.size && [...expected].every(([id, h]) => seen.get(id) === h);
  if (!same) throw new Error(`check failed for ${name}`);
  const newSize = fs.statSync(out).size;
  after += newSize;
  console.log(`${name}: ${total} -> ${keep.size} lines, ${(size / 1048576).toFixed(0)} -> ${(newSize / 1048576).toFixed(0)} MB`);
  if (apply) {
    if (fs.statSync(file).size !== size) throw new Error(`${name} changed while compacting; is the connector stopped?`);
    fs.copyFileSync(out, file + '.compact');
    fs.renameSync(file + '.compact', file);
  }
  fs.unlinkSync(out);
}
console.log(`total ${(before / 1073741824).toFixed(1)} GB -> ${(after / 1073741824).toFixed(1)} GB${apply ? '' : ' (dry run)'}`);
