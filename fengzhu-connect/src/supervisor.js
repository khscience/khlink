// The scheduled task's own process. Task Scheduler ends every process a task
// started once its first one exits, so restarting the connector used to take
// the Codex host down with it and cut off a turn started from the phone. This
// process stays put and runs the connector as its child: a reload swaps only
// the connector, while the Codex host (and the tools a turn is running) stay
// in the task and the new connector takes the host over.
//
// Reload: create <dataDir>/reload.request (ops/restart-connector.ps1 does).
//
// The Codex host is started here too, on the connector's request: Node puts a
// process's children in a job that ends them when it exits, so a host started
// by the connector died with it. Started by this process it outlives a
// connector swap, and still ends with the task (this process's own job).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER_ENV = 'KHLINK_CONNECTOR_WORKER';

function runSupervised({ dataDir, argv, execPath = process.execPath, log = console.log, spawnFn = spawn, pollMs = 1000, handoverMs = 15_000, exit = (code) => process.exit(code), hostScript = path.join(__dirname, 'codex-host.js') }) {
  const request = path.join(dataDir, 'reload.request');
  // A request left from before this start would reload at once.
  try { fs.rmSync(request, { force: true }); } catch { /* none */ }
  let worker = null; let reloading = false;
  // A message to a connector that has just gone must not crash this process
  // (an unanswered send raises an 'error' event later, outside any try).
  const tell = (child, message) => { if (child?.connected) child.send(message, () => {}); };
  const start = () => {
    worker = spawnFn(execPath, argv, { env: { ...process.env, [WORKER_ENV]: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    worker.on('error', (error) => log(`supervisor: connector process error: ${error.message}`));
    log(`supervisor pid=${process.pid}: connector pid=${worker.pid}`);
    const current = worker;
    current.on('message', (message) => {
      // Only the Codex host script, only from the connector we started.
      if (message?.type !== 'spawn-codex-host' || !Array.isArray(message.args) || path.resolve(String(message.args[0])) !== path.resolve(hostScript)) return;
      const host = spawnFn(execPath, message.args.map(String), { stdio: 'ignore', windowsHide: true, detached: false });
      log(`supervisor: Codex host pid=${host.pid}`);
      host.on('exit', (code) => tell(worker, { type: 'codex-host-exit', pid: host.pid, code }));
    });
    current.on('exit', (code, signal) => {
      if (current !== worker) return;
      if (reloading) { reloading = false; start(); return; }
      // Ended on its own: end the task the same way, so its restart rules apply.
      log(`supervisor: connector exited code=${code} signal=${signal || '-'}`);
      clearInterval(timer);
      exit(Number.isInteger(code) ? code : 1);
    });
  };
  const timer = setInterval(() => {
    if (reloading || !fs.existsSync(request)) return;
    try { fs.rmSync(request, { force: true }); } catch { /* raced */ }
    reloading = true;
    log('supervisor: reload requested');
    const old = worker;
    // The connector saves what it holds and leaves; if it cannot, stop it.
    tell(old, { type: 'reload' });
    const force = setTimeout(() => { if (old.exitCode === null && old.signalCode === null) { log('supervisor: connector did not leave, stopping it'); try { old.kill(); } catch { /* gone */ } } }, handoverMs);
    force.unref?.();
  }, pollMs);
  start();
  return { stop() { clearInterval(timer); try { worker?.kill(); } catch { /* gone */ } }, get worker() { return worker; } };
}

module.exports = { runSupervised, WORKER_ENV };
