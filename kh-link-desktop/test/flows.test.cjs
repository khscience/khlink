const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const KhConnection = require('../src/connection');

const state = (overrides = {}) => ({ authenticated: false, connectionMode: 'server', server: 'https://example.invalid',
  connector: { updatedAt: Date.now(), lifecycle: 'running', connectionMode: 'server', connected: false }, ...overrides });
const directState = (authenticated = false) => state({ authenticated, connectionMode: 'direct',
  profile: authenticated ? { displayName: '原账户', khQuantSubject: '123' } : null,
  connector: { updatedAt: Date.now(), lifecycle: 'running', connectionMode: 'direct', directConnected: false } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Run the shipped controllers against their real HTML IDs and a small DOM.
// IPC is controlled so delayed responses, cancellations and expiry are reproducible.
function app(handlers = {}, initialState = state()) {
  class Element {
    constructor(id) { this.id = id; this._textContent = ''; this.textWrites = 0; this.value = ''; this.disabled = false; this.checked = false;
      this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this.classes = new Set();
      this.classList = { contains: (name) => this.classes.has(name), add: (name) => this.classes.add(name),
        toggle: (name, force) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); return on; } };
    }
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this._textContent; }
    set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._textContent = String(value); this.textWrites++; }
    setAttribute(key, value) { this.attrs[key] = value; }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._textContent = ''; this.append(...children); }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parentNode) child.remove();
      const index = before == null ? this.children.length : this.children.indexOf(before);
      if (index < 0) throw new Error('reference is not a child');
      this.children.splice(index, 0, child); child.parentNode = this; this._textContent = '';
    }
    remove() { if (!this.parentNode) return; const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    querySelector() { return this; }
    scrollIntoView() {}
  }
  const elements = new Map();
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"[^>]*class="([^"]*)"|id="([^"]+)"/g)) {
    const element = new Element(match[1] || match[3]);
    for (const className of (match[2] || '').split(' ')) if (className) element.classes.add(className);
    elements.set(element.id, element);
  }
  const calls = []; const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ KhConnection, console, URL, Date, Promise,
    document: { hidden: false, getElementById: (id) => { assert.ok(elements.has(id), `missing shipped HTML element ${id}`); return elements.get(id); },
      createElement: () => new Element('created'), addEventListener() {}, querySelectorAll: () => [] },
    matchMedia: () => ({ matches: true }), addEventListener() {}, cancelAnimationFrame() {},
    setInterval: () => ++timerId, clearInterval() {},
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    __TAURI__: { core: { invoke: async (name, args) => { calls.push(name); if (handlers[name]) return handlers[name](args);
      if (name === 'get_state') return initialState; if (name === 'account') return { profile: initialState.profile, devices: [] };
      if (name === 'direct_status' || name === 'direct_cancel') return { mode: initialState.connectionMode, status: 'idle' };
      return {}; } } },
  });
  context.window = context;
  for (const file of ['main.js', 'direct.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context, { filename: file });
  return { calls, elements, timers, context, run: (code) => vm.runInContext(code, context),
    async nextLoginPoll() { const entry = [...timers].find(([, value]) => value.delay === 900); assert.ok(entry, 'expected a pending login poll'); timers.delete(entry[0]); return entry[1].callback(); } };
}

test('diagnostics still opens when usage is unavailable', async () => {
  const a = app({
    diagnostics: () => ({ current: { connected: true, version: '0.2.132', lifecycle: 'running' }, heartbeatAgeMs: 1000, checks: [], entries: [] }),
    usage: () => { throw new Error('usage unavailable'); },
  });
  await a.run('loadDiagnostics()');
  assert.equal(a.elements.get('diagnostics-dialog').classes.has('hidden'), false);
  assert.match(a.elements.get('toast').textContent, /用量暂时不可用/);
  assert.equal(a.elements.get('diagnostic-version').textContent, 'v0.2.132 · running');
});

test('desktop updates use verified downloads instead of the external-link allowlist', async () => {
  const download = deferred();
  const a = app({
    connector_update_check: async () => ({ bundled: false, desktop: { available: true, latest: '0.1.28', url: 'https://github.com/example/installer.exe' } }),
    desktop_update_download: () => download.promise,
  });
  await a.run('checkUpdates()');
  const pending = a.run('runUpdate()');
  await tick();
  assert.equal(a.elements.get('update-label').textContent, '正在下载并校验桌面安装包…');
  await a.run('runUpdate()');
  assert.equal(a.calls.filter((name) => name === 'desktop_update_download').length, 1);
  assert.equal(a.calls.includes('open_external'), false);
  download.resolve({ fileName: 'khLink-Setup-0.1.28.exe' });
  await pending;
  assert.match(a.elements.get('toast').textContent, /安装包已下载/);
  assert.equal(a.elements.get('update-button').disabled, false);
});

test('manual update check replaces a stale offer and does not start overlapping checks', async () => {
  const next = deferred();
  let checks = 0;
  const a = app({ connector_update_check: () => {
    checks++;
    return checks === 1 ? { bundled: false, desktop: { available: true, latest: '0.1.27', url: 'https://example.invalid/old' } } : next.promise;
  } });
  await a.run('checkUpdates()');
  assert.match(a.elements.get('update-label').textContent, /0\.1\.27/);
  const pending = a.run('checkUpdates(true)');
  await tick();
  assert.equal(a.elements.get('check-updates-button').disabled, true);
  await a.run('checkUpdates(true)');
  assert.equal(checks, 2);
  next.resolve({ bundled: false, desktop: { available: true, latest: '0.1.37', url: 'https://example.invalid/new' } });
  await pending;
  assert.match(a.elements.get('update-label').textContent, /0\.1\.37/);
  assert.equal(a.elements.get('check-updates-button').disabled, false);
  assert.equal(a.elements.get('toast').textContent, '发现可用更新');
});

test('failed manual update check identifies the previous offer as stale and allows retry', async () => {
  let checks = 0;
  const a = app({ connector_update_check: () => {
    checks++;
    if (checks === 2) throw new Error('offline');
    return checks === 1 ? { bundled: false, desktop: { available: true, latest: '0.1.27', url: 'https://example.invalid/old' } } : { bundled: false, desktop: { available: false } };
  } });
  await a.run('checkUpdates()');
  await a.run('checkUpdates(true)');
  assert.match(a.elements.get('update-label').textContent, /0\.1\.27.*上次结果，检查失败/);
  assert.match(a.elements.get('toast').textContent, /检查更新失败/);
  assert.equal(a.elements.get('check-updates-button').disabled, false);
  await a.run('checkUpdates(true)');
  assert.equal(a.elements.get('update-row').classList.contains('hidden'), true);
  assert.equal(a.elements.get('toast').textContent, '当前已是最新版本');
});

test('returning to the visible desktop refreshes an old update check with a cooldown', async () => {
  const a = app({ connector_update_check: () => ({ bundled: false, desktop: { available: false } }) });
  await a.run('checkUpdates()');
  a.run('refreshWhenVisible()'); await tick();
  assert.equal(a.calls.filter((name) => name === 'connector_update_check').length, 1);
  a.run('updateCheckStartedAt = Date.now() - 61_000');
  a.run('refreshWhenVisible()'); await tick();
  assert.equal(a.calls.filter((name) => name === 'connector_update_check').length, 2);
  a.context.document.hidden = true;
  a.run('updateCheckStartedAt = Date.now() - 61_000; refreshWhenVisible()'); await tick();
  assert.equal(a.calls.filter((name) => name === 'connector_update_check').length, 2);
});

test('a running connector is distinct from an authenticated account or a connected phone', () => {
  const anonymous = KhConnection.view(state());
  assert.equal(anonymous.running, true); assert.equal(anonymous.loginRequired, true); assert.equal(anonymous.online, false);
  const direct = KhConnection.view(directState(true));
  assert.equal(direct.authenticated, true); assert.equal(direct.loginRequired, false); assert.equal(direct.online, false);
  const stale = KhConnection.view(state({ authenticated: true, connector: { connected: true, updatedAt: Date.now() - 60_000 } }));
  assert.equal(stale.online, false);
  const switching = KhConnection.view(state({ authenticated: true, connectionMode: 'direct', connector: { connectionMode: 'server', connected: true, updatedAt: Date.now() } }));
  assert.equal(switching.online, false);
});

test('unchanged device polls preserve rows, controls and announcement text', () => {
  const a = app();
  const devices = [{ id: 'phone-1', name: '测试手机', type: 'android', online: true }, { id: 'desktop-1', name: '另一台电脑', type: 'connector', online: false }];
  a.context.devices = devices;
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true, deviceId: 'local' }))}; renderDevices(devices)`);
  const target = a.elements.get('device-list'); const first = target.children[0]; const second = target.children[1];
  const revoke = first.children[2]; const countWrites = a.elements.get('device-count').textWrites;
  for (let i = 0; i < 15; i++) a.run('renderDevices(devices)');
  assert.equal(target.children[0], first); assert.equal(target.children[1], second);
  assert.equal(first.children[2], revoke); assert.equal(a.elements.get('device-count').textWrites, countWrites);
  a.run(`renderDevices([{ id: 'desktop-1', name: '另一台电脑', type: 'connector', online: false }, { id: 'phone-1', name: '测试手机', type: 'android', online: true }])`);
  assert.equal(target.children[0], first); assert.equal(target.children[1], second);
});

test('state polling and an explicit account refresh leave unchanged rows in place', async () => {
  const profile = { displayName: '测试账户', khQuantSubject: 'test' };
  const next = state({ authenticated: true, profile, deviceId: 'local' });
  const a = app({ account: () => ({ profile, devices: [{ id: 'phone-1', name: '测试手机', type: 'android', online: true }], entitlements: [] }) }, next);
  await a.run('load()'); await tick();
  const target = a.elements.get('device-list'); const first = target.children[0];
  assert.ok(first);
  a.context.next = next; a.run('applyDesktopState(next)'); await a.run('loadAccount()');
  assert.equal(target.children[0], first); assert.equal(target.children[0].children[2].textContent, '解除绑定');
});

test('server response order does not reshuffle devices with the same online state', () => {
  const a = app();
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true }))}; renderDevices([
    {id:'a',name:'手机甲',type:'android',online:true}, {id:'b',name:'手机乙',type:'android',online:true}])`);
  const list = a.elements.get('device-list'); const first = list.children[0]; const second = list.children[1];
  a.run(`renderDevices([{id:'b',name:'手机乙',type:'android',online:true}, {id:'a',name:'手机甲',type:'android',online:true}])`);
  assert.equal(list.children[0], first); assert.equal(list.children[1], second);
});

test('device changes update and reorder existing rows without replacing their controls', async () => {
  const a = app();
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true, deviceId: 'local' }))}; renderDevices([
    { id:'phone-1', name:'原手机名', type:'android', online:true }, { id:'desktop-1', name:'电脑', type:'connector', online:false }])`);
  const target = a.elements.get('device-list'); const phone = target.children[0]; const computer = target.children[1]; const revoke = phone.children[2];
  a.run(`renderDevices([{ id:'desktop-1', name:'电脑', type:'connector', online:true }, { id:'phone-1', name:'新手机名', type:'android', online:false }])`);
  assert.equal(target.children[0], computer); assert.equal(target.children[1], phone); assert.equal(phone.children[2], revoke);
  assert.match(phone.textContent, /新手机名/); assert.match(phone.textContent, /已绑定/); assert.match(computer.textContent, /在线/);
  let confirmation = ''; a.context.confirm = (text) => { confirmation = text; return false; };
  await revoke.listeners.click(); assert.match(confirmation, /新手机名/); assert.equal(a.calls.includes('revoke_device'), false);
  a.run(`renderDevices([{ id:'desktop-1', name:'电脑', type:'connector', online:true }])`);
  assert.deepEqual(target.children, [computer]); assert.equal(a.elements.get('device-count').textContent, '1 个设备');
});

test('computer devices can be unbound from the desktop console', async () => {
  const a = app();
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true, deviceId: 'local' }))}; renderDevices([
    { id:'desktop-1', name:'另一台电脑', type:'connector', online:true }])`);
  const row = a.elements.get('device-list').children[0];
  assert.equal(row.children[2].textContent, '解除绑定');
  let confirmation = ''; a.context.confirm = (text) => { confirmation = text; return false; };
  await row.children[2].listeners.click();
  assert.match(confirmation, /另一台电脑/);
  assert.match(confirmation, /这台电脑/);
  assert.equal(a.calls.includes('revoke_device'), false);
});

test('empty and direct placeholders stay stable and returning restores account rows', () => {
  const a = app(); const target = a.elements.get('device-list');
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true }))}; renderDevices([])`);
  const initialWrites = target.textWrites; a.run('renderDevices([])'); assert.equal(target.textWrites, initialWrites);
  a.run(`renderDevices([{id:'phone',name:'手机',type:'android'}])`); const first = target.children[0];
  a.run(`desktopState = ${JSON.stringify(directState(true))}; renderConnector()`);
  const directWrites = target.textWrites; a.run('renderConnector()'); assert.equal(target.textWrites, directWrites);
  a.run(`desktopState = ${JSON.stringify(state({ authenticated: true }))}; renderDevices([{id:'phone',name:'手机',type:'android'}])`);
  assert.notEqual(target.children[0], first); assert.match(target.children[0].textContent, /手机/);
});

test('anonymous direct mode keeps login visible and does not fetch the cloud account', async () => {
  const a = app({}, directState());
  await a.run('load()');
  assert.equal(a.elements.get('app-view').classList.contains('hidden'), false);
  assert.equal(a.elements.get('header-login-button').classList.contains('hidden'), false);
  assert.equal(a.elements.get('account-connect-button').classList.contains('hidden'), false);
  assert.equal(a.elements.get('logout-button').classList.contains('hidden'), true);
  assert.equal(a.calls.includes('account'), false);
  await a.run('useAccountConnection()');
  assert.equal(a.elements.get('login-view').classList.contains('hidden'), false);
  assert.equal(a.calls.includes('direct_server'), false, 'opening login preserves an active direct transport');
});

test('saved account identity survives direct mode and returning uses the account connection action', async () => {
  const a = app({}, directState(true));
  await a.run('load()');
  assert.equal(a.elements.get('account-name').textContent, '原账户');
  assert.equal(a.elements.get('account-connect-button').textContent, '恢复账户连接');
  assert.equal(a.calls.includes('account'), false);
  await a.run('useAccountConnection()');
  assert.equal(a.calls.filter((name) => name === 'ensure_connector').length, 1);
});

test('a delayed cloud reply cannot overwrite account identity after switching to direct mode', async () => {
  const pending = deferred();
  const a = app({ account: () => pending.promise }, state({ authenticated: true, profile: { displayName: '原账户', khQuantSubject: '123' } }));
  await a.run('load()');
  a.context.nextState = directState(true);
  a.run('applyDesktopState(nextState)');
  pending.resolve({ profile: { displayName: '过期响应' }, devices: [] }); await tick();
  assert.equal(a.elements.get('account-name').textContent, '原账户');
  assert.equal(a.elements.get('membership-details').classList.contains('hidden'), true);
});

test('OAuth polling waits for completion and enables a second login after success', async () => {
  const pending = deferred();
  const a = app({ poll_login: () => pending.promise });
  await a.run('load()'); a.run('openLogin()'); await a.run('beginLogin()');
  const polling = a.nextLoginPoll(); await tick();
  assert.equal(a.calls.filter((name) => name === 'poll_login').length, 1);
  assert.equal([...a.timers.values()].some((timer) => timer.delay === 900), false, 'no overlapping OAuth redemption');
  pending.resolve({ status: 'complete' }); await polling;
  assert.equal(a.elements.get('login-button').disabled, false);
  assert.equal(a.elements.get('login-view').classList.contains('hidden'), true);
  a.run('openLogin()'); await a.run('beginLogin()');
  assert.equal(a.calls.filter((name) => name === 'begin_login').length, 2);
});

test('cancelled OAuth cannot apply a late successful response or block retry', async () => {
  const pending = deferred();
  const a = app({ poll_login: () => pending.promise }, directState());
  await a.run('load()'); a.run('openLogin()'); await a.run('beginLogin()');
  const polling = a.nextLoginPoll(); await tick();
  await a.run('closeLogin()'); const before = a.calls.filter((name) => name === 'get_state').length;
  pending.resolve({ status: 'complete' }); await polling;
  assert.equal(a.calls.filter((name) => name === 'get_state').length, before);
  assert.equal(a.elements.get('login-button').disabled, false);
  a.run('openLogin()'); await a.run('beginLogin()');
  assert.equal(a.calls.filter((name) => name === 'begin_login').length, 2);
});

test('opening direct pairing generates the phone QR automatically and cancelling preparation keeps account mode', async () => {
  const initial = state({ authenticated: true });
  const a = app({ direct_begin: () => ({ mode: 'server', status: 'waiting', singleScan: true, id: 'offer', payload: 'offer-data', expiresAt: Date.now() + 300000, qrSvg: '<svg/>' }) }, initial);
  await a.run('load()'); await tick(); await a.run('openDirect()');
  assert.equal(a.calls.filter((name) => name === 'direct_begin').length, 1);
  assert.equal(a.elements.has('direct-confirm'), false); assert.equal(a.elements.has('direct-answer'), false);
  assert.equal(a.calls.includes('direct_answer'), false);
  assert.equal(a.elements.get('account-mode-button').attrs['aria-pressed'], 'true');
  await a.run('closeDirect()');
  assert.equal(a.calls.includes('direct_cancel'), true);
  assert.equal(a.elements.get('account-mode-button').attrs['aria-pressed'], 'true');
});

test('a phone answer arriving automatically refreshes the desktop and keeps account login visible', async () => {
  let connected = false;
  const a = app({
    direct_status: () => connected ? { mode: 'direct', status: 'connected', connected: true, phoneName: '测试手机' } : { mode: 'server', status: 'waiting', singleScan: true },
    get_state: () => connected ? directState() : state(),
  });
  await a.run('load()'); await a.run('openDirect()'); connected = true; await a.run('pollDirect()');
  assert.match(a.elements.get('direct-status').textContent, /^已直连 测试手机/);
  assert.equal(a.elements.get('header-login-button').classList.contains('hidden'), false);
  assert.equal(a.calls.includes('direct_answer'), false);
  await a.run('closeDirect()'); assert.equal(a.calls.includes('direct_cancel'), false);
});

test('closing before the next UI poll preserves a phone that has just connected', async () => {
  let connected = false;
  const a = app({ direct_status: () => connected ? { mode: 'direct', status: 'connected', connected: true }
    : { mode: 'server', status: 'waiting', singleScan: true } });
  await a.run('load()'); await a.run('openDirect()'); connected = true;
  await a.run('closeDirect()'); assert.equal(a.calls.includes('direct_cancel'), false);
});

test('closing a connected QR dialog keeps the phone connected', async () => {
  const a = app({ direct_status: () => ({ mode: 'direct', status: 'connected', connected: true, phoneName: '测试手机' }) }, directState(true));
  await a.run('load()'); await a.run('openDirect()'); await a.run('closeDirect()');
  assert.equal(a.calls.includes('direct_cancel'), false);
});
