// KH Link ↔ DeepSeek Harness desktop bridge.
//
// The DeepSeek Harness desktop app keeps its local Host API behind a per-process
// launch token that only its Electron renderer receives.  This tiny in-process
// plugin publishes that tokenized loopback URL to a user-scoped file so the KH
// Link connector can attach to the *same* live Host (same sessions, same
// running turns) instead of starting a second DSH process.
//
// The file is written under %LOCALAPPDATA%\KH Link (the connector's own data
// directory), is refreshed while the Host lives, and is removed when the plugin
// is disposed.  Nothing is sent anywhere; no vendor credential is read.
//
// Installed by the KH Link connector into
//   $DSH_HOME/profiles/node_modules/kh-link-dsh-bridge
// and enabled by one row in $DSH_HOME/profiles/desktop/cordis.patch.yml.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'kh-link-dsh-bridge';

// Mount after both services exist; the Host is ready by then.
export const inject = ['webServer', 'connection'];

const HEARTBEAT_MS = 20_000;
const SCHEMA = 1;

function bridgeDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'KH Link');
}

function bridgeFile() {
  return path.join(bridgeDir(), 'dsh-desktop-bridge.json');
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '';
  }
}

function publish(ctx, state) {
  try {
    const base = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
    const url = ctx.connection.authenticatedUrl(base);
    const value = {
      schema: SCHEMA,
      url,
      port: ctx.webServer.port,
      pid: process.pid,
      profile: ctx.get('profileContext')?.name || 'desktop',
      hostVersion: readVersion(),
      updatedAt: Date.now(),
    };
    const dir = bridgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = bridgeFile();
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
    state.file = file;
    state.pid = process.pid;
  } catch (error) {
    // Never print the URL/token: only the failure class.
    ctx.logger?.warn?.(`kh-link-dsh-bridge: cannot publish Host URL (${error?.code || 'error'})`);
  }
}

export function apply(ctx) {
  // The row is only installed for the Desktop profile, but keep a defensive
  // guard so copying the patch elsewhere can never publish another profile.
  const profile = ctx.get('profileContext')?.name;
  if (profile !== undefined && profile !== 'desktop') return;

  const state = { file: null, pid: process.pid };
  publish(ctx, state);

  const timer = setInterval(() => publish(ctx, state), HEARTBEAT_MS);
  timer.unref?.();

  ctx.effect(() => () => {
    clearInterval(timer);
    try {
      if (!state.file) return;
      const current = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      if (Number(current.pid) === state.pid) fs.rmSync(state.file, { force: true });
    } catch {
      // A missing or already-replaced file needs no cleanup.
    }
  }, 'kh-link-dsh-bridge: published URL');
}
