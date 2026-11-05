#!/usr/bin/env node
// First, before any module keeps a reference to fs/child_process functions.
require('./sync-probe').installSyncProbe();
const os = require('node:os');
// Task Scheduler starts us below normal priority. With the PC busy (a render
// using every core) the connector then got no CPU for 25 minutes and the
// phone lost it. Normal priority for this process and what it starts.
try { os.setPriority(os.constants.priority.PRIORITY_NORMAL); } catch { /* not allowed: keep going */ }
const crypto = require('node:crypto');
// The Windows resolver can return the local test-network address before the
// reachable IPv4 route. Prefer IPv4 for the relay so a connector restart does
// not look like a long offline period when the first fetch times out.
require('node:dns').setDefaultResultOrder('ipv4first');
const { loadConfig, saveConfig, file, DEFAULT_SERVER_URL } = require('./config');
const { BridgeApi } = require('./api');
const { Connector } = require('./connector');
const { ready } = require('./crypto');
const { findCodexBinary } = require('./codex-client');
const { installMcp } = require('./mcp-install');
const { installFileLog, cleanStaleTemps } = require('./file-log');
const path = require('node:path');
const CONNECTOR_VERSION = require('../package.json').version;

function arg(name, fallback = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; }

async function main() {
  const command = process.argv[2] || 'start';
  // The process Task Scheduler started only supervises; the connector runs as
  // its child so that it can be swapped without ending the task (see supervisor.js).
  const { runSupervised, WORKER_ENV } = require('./supervisor');
  if (command === 'start' && !process.env[WORKER_ENV] && !process.argv.includes('--no-supervisor')) {
    installFileLog(path.join(path.dirname(file), 'logs'));
    runSupervised({ dataDir: path.dirname(file), argv: process.argv.slice(1), log: (line) => console.log(`[fengzhu-connect] ${line}`) });
    return;
  }
  // A start that stalls (seen once under Task Scheduler: no output at all and
  // the process idle) keeps the task "Running", and with IgnoreNew no later
  // trigger or restart-on-failure starts another one: the computer stays
  // offline until someone steps in. Give up instead, so the task starts afresh.
  const startupWatchdog = command === 'start' ? setTimeout(() => {
    console.error('[fengzhu-connect] start did not finish within 3 minutes; exiting so a fresh one is started');
    process.exit(1);
  }, 180_000) : null;
  await ready();
  if (command === 'setup') {
    const password = process.env.FENGZHU_BRIDGE_PASSWORD;
    if (!password || password.length < 16) throw new Error('Set FENGZHU_BRIDGE_PASSWORD to a passphrase of at least 16 characters for setup');
    const serverUrl = arg('server', DEFAULT_SERVER_URL);
    if (!serverUrl) throw new Error('Pass --server <relay URL> for setup');
    const config = saveConfig({ serverUrl, deviceId: crypto.randomUUID(),
      deviceName: arg('name', os.hostname()), workspace: arg('workspace', process.env.USERPROFILE), codexBin: arg('codex-bin'), accountKey: '' });
    await new BridgeApi(config).setup(password); console.log(`Configured ${file}`); return;
  }
  const config = loadConfig();
  if (command === 'mcp-install') {
    console.log(JSON.stringify(installMcp(config), null, 2)); return;
  }
  if (command === 'enroll-envelope') {
    const password = process.env.FENGZHU_BRIDGE_PASSWORD;
    if (!password || password.length < 16) throw new Error('Set FENGZHU_BRIDGE_PASSWORD for enrollment');
    await new BridgeApi(config).setup(password); console.log('Account key envelope enrolled'); return;
  }
  if (command === 'doctor') {
    const response = await fetch(`${config.serverUrl}/healthz`); console.log(JSON.stringify({ config: file, codex: findCodexBinary(config.codexBin), server: response.status }, null, 2)); return;
  }
  if (process.argv.includes('--codex-host')) config.useCodexHost = true;
  const dataDir = path.dirname(config.configFile || file);
  installFileLog(path.join(dataDir, 'logs'));
  cleanStaleTemps(dataDir);
  console.log(`[fengzhu-connect] starting v${CONNECTOR_VERSION} pid=${process.pid} node=${process.version} codexHost=${!!config.useCodexHost}`);
  // Node 22 terminates the process on an unhandled rejection. A stray async
  // failure in a timer must not silently take the connector offline, so log it
  // and keep running. A synchronous uncaught exception leaves state unknown:
  // log it and exit non-zero so the scheduled task restarts a clean process.
  process.on('unhandledRejection', (reason) => { console.error('[fengzhu-connect] unhandled rejection:', reason?.stack || reason); });
  process.on('uncaughtException', (error) => { console.error('[fengzhu-connect] uncaught exception, exiting:', error?.stack || error); process.exit(1); });
  process.on('exit', (code) => { console.log(`[fengzhu-connect] exit code=${code}`); });
  const connector = new Connector(config);
  let shuttingDown = false;
  const requestShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const result = await connector.shutdown({ requireIdle: true });
    if (!result.ok) {
      console.error(`[fengzhu-connect] safe stop refused: ${result.activeThreads?.length || 0} active task(s)`);
      shuttingDown = false;
      return;
    }
    process.exitCode = 0;
  };
  // Asked by the supervisor to make way for a new connector: save and leave,
  // leaving the Codex host (and any turn it runs) for the next one.
  process.on('message', (message) => {
    if (message?.type !== 'reload') return;
    console.log('[fengzhu-connect] reload: handing over to a new connector; the Codex host stays');
    connector.prepareReload().catch((error) => console.error(error?.stack || error)).finally(() => process.exit(0));
  });
  process.on('SIGINT', () => { requestShutdown().catch((error) => { console.error(error.stack || error); shuttingDown = false; }); });
  process.on('SIGTERM', () => { requestShutdown().catch((error) => { console.error(error.stack || error); shuttingDown = false; }); });
  await connector.start(); clearTimeout(startupWatchdog); console.log(`Fengzhu connector online as ${config.deviceName}`);
}
main().catch((error) => {
  // A second scheduled/manual launch is expected after the single-instance
  // guard. Keep it quiet and successful so the scheduler does not retry-loop;
  // real startup failures remain non-zero and visible.
  console.error(`[fengzhu-connect] ${error?.message || error}`);
  process.exitCode = error?.code === 'EALREADY' ? 0 : 1;
  // Exit for real: a half-started connector (Codex host child, timers) would
  // otherwise linger without a relay connection, and the scheduled task would
  // keep reporting it as running and never start a replacement.
  if (process.argv[2] === undefined || process.argv[2] === 'start') process.exit(process.exitCode);
});
