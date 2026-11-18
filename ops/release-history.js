'use strict';
// Release notes of every version of one part (android, connector, desktop),
// newest first, from releases/notes/<part>-<version>.md. The update manifest
// carries them as `history`, so an update that skips versions can show what
// each of them brought; clients pick the versions newer than what they run.
const fs = require('node:fs');
const path = require('node:path');

const MAX_VERSIONS = 30;

/** One change per line, list markers dropped (as publish-release.sh writes `notes`). */
function notesOf(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).join('\n');
}

function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** [{ version, notes }] for `part` up to and including `current`, newest first. */
function historyOf(part, current, dir = path.join(__dirname, '..', 'releases', 'notes')) {
  const pattern = new RegExp(`^${part}-(\\d+(?:\\.\\d+)*)\\.md$`);
  const entries = fs.readdirSync(dir)
    .map((name) => { const match = name.match(pattern); return match && { version: match[1], file: path.join(dir, name) }; })
    .filter((entry) => entry && compareVersions(entry.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  // Android's installation prompt must be able to describe every skipped
  // release for which we have notes, even after a long time between updates.
  return (part === 'android' ? entries : entries.slice(0, MAX_VERSIONS))
    .map((entry) => ({ version: entry.version, notes: notesOf(entry.file) }))
    .filter((entry) => entry.notes);
}

module.exports = { historyOf, compareVersions, notesOf };
