// Stand-in connector for supervisor.test.js: writes its pid, leaves on a
// reload message, exits with code 7 once <dir>/crash appears.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
fs.appendFileSync(path.join(dir, 'pids.txt'), `${process.pid}\n`);
process.on('message', (message) => {
  if (message?.type !== 'reload') return;
  fs.appendFileSync(path.join(dir, 'left.txt'), `${process.pid}\n`);
  process.exit(0);
});
setInterval(() => { if (fs.existsSync(path.join(dir, 'crash'))) process.exit(7); }, 50);
// Asked to: request a Codex host start (and a disallowed script first).
if (process.env.SPAWN_HOST && !fs.existsSync(path.join(dir, 'host-requested'))) {
  fs.writeFileSync(path.join(dir, 'host-requested'), '');
  process.send({ type: 'spawn-codex-host', args: [path.join(dir, 'evil.js')] });
  process.send({ type: 'spawn-codex-host', args: [process.env.SPAWN_HOST, dir] });
}
