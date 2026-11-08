const invoke = window.__TAURI__.core.invoke;
let desktopState = null;
let accountData = null;
let loginTimer = null;
let loginBusy = false;
let loginEpoch = 0;
let accountEpoch = 0;
let dashboardShown = false;
let accountConnectionBusy = false;
let pairingTimer = null;
let pairingPollBusy = false;
let connectorTimer = null;
let connectorPollBusy = false;
let accountLoadBusy = false;
let accountLoadAttempt = 0;
let accountRetryTimer = null;
let pairing = null;
let diagnosticsLoadBusy = false;
let usageLoadBusy = false;
let usageTimer = null;
let updateInfo = null;
let updateBusy = false;
let updateBusyKind = null;
let updateCheckBusy = false;
let updateCheckStartedAt = 0;
let updateCheckFailed = false;
let deviceListMode = null;
const deviceRows = new Map();
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_FOCUS_CHECK_INTERVAL_MS = 60 * 1000;

const $ = (id) => document.getElementById(id);
const show = (id, visible = true) => $(id).classList.toggle('hidden', !visible);
const motion = window.gsap || null;
const motionMedia = motion ? motion.matchMedia() : null;
let reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

if (motion) {
  motion.defaults({ duration: 0.36, ease: 'power2.out' });
  motionMedia.add({ reduceMotion: '(prefers-reduced-motion: reduce)' }, (context) => {
    reduceMotion = Boolean(context.conditions.reduceMotion);
    return () => {};
  });
}

function animateReveal(id, selector = null) {
  if (!motion || reduceMotion) return;
  const root = $(id);
  if (!root) return;
  const target = selector ? root.querySelector(selector) : root;
  motion.fromTo(target, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.34, ease: 'power3.out', overwrite: 'auto' });
}

function animateDashboard() {
  if (!motion || reduceMotion) return;
  const timeline = motion.timeline({ defaults: { ease: 'power3.out' } });
  timeline
    .from('.app-header', { autoAlpha: 0, y: -10, duration: 0.35 })
    .from('.connection-strip', { autoAlpha: 0, y: 12, duration: 0.38 }, '-=0.16')
    .from('.dashboard-grid .panel', { autoAlpha: 0, y: 18, duration: 0.42, stagger: 0.07 }, '-=0.2')
    .from('.app-footer', { autoAlpha: 0, duration: 0.25 }, '-=0.12');
}

function animateStatusChange() {
  if (!motion || reduceMotion) return;
  motion.fromTo('.live-status', { scale: 0.96, autoAlpha: 0.7 }, { scale: 1, autoAlpha: 1, duration: 0.3, ease: 'back.out(1.5)', overwrite: 'auto' });
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  show('toast');
  if (motion && !reduceMotion) motion.fromTo(element, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.25, overwrite: 'auto' });
  clearTimeout(element.timer);
  element.timer = setTimeout(() => {
    if (motion && !reduceMotion) motion.to(element, { autoAlpha: 0, y: 8, duration: 0.2, onComplete: () => show('toast', false) });
    else show('toast', false);
  }, 3200);
}

function initials(name) {
  const value = String(name || 'KH').trim();
  return /^[\x00-\xff]+$/.test(value) ? value.slice(0, 2).toUpperCase() : value.slice(-2);
}

function stateLabel(state) {
  return ({ active: '有效', expiring: '即将到期', expired: '已到期', payment_pending: '支付处理中', account_exception: '账户异常', unavailable: '暂不可用' })[state] || '未开通';
}

function expiryLabel(value, fallback) {
  return value ? `有效期至 ${new Date(value).toLocaleDateString('zh-CN')}` : fallback;
}

async function load() {
  try {
    applyDesktopState(await invoke('get_state'));
    show('app-view');
    if (!dashboardShown) { dashboardShown = true; animateDashboard(); }
    startConnectorPolling();
    loadUsage();
    if (!usageTimer) usageTimer = setInterval(loadUsage, 30_000);
  } catch (error) { toast(String(error)); }
}

function applyDesktopState(next) {
  const previous = desktopState;
  const changed = previous && (KhConnection.view(previous).direct !== KhConnection.view(next).direct ||
    previous.authenticated !== next.authenticated || previous.profile?.khQuantSubject !== next.profile?.khQuantSubject);
  if (changed) { accountEpoch++; clearTimeout(accountRetryTimer); accountRetryTimer = null; accountLoadAttempt = 0; }
  if (!next.authenticated || previous?.profile?.khQuantSubject !== next.profile?.khQuantSubject) accountData = null;
  desktopState = next;
  renderConnector();
  renderAccount();
  const model = KhConnection.view(desktopState);
  if (model.authenticated && !model.direct && !accountData && !accountLoadBusy && !accountRetryTimer && accountLoadAttempt < 3) loadAccount();
}

function renderAccount() {
  const model = KhConnection.view(desktopState);
  const profile = accountData?.profile || desktopState?.profile || {};
  const name = model.authenticated ? profile.displayName || 'khLink 用户' : '未登录账户';
  $('avatar').textContent = model.authenticated ? initials(name) : 'KH';
  $('sheet-avatar').textContent = $('avatar').textContent;
  $('account-name').textContent = name;
  $('nav-account-name').textContent = name;
  $('account-summary-name').textContent = name;
  $('account-subject').textContent = model.authenticated ? `账号 ID ${profile.khQuantSubject || ''}` : '登录后可使用账户连接';
  const detail = model.direct ? (model.authenticated ? '登录信息已保留，直连期间暂停账户服务。' : '当前为二维码直连，无需账户。') :
    model.authenticated ? '手机登录同一 khLink 账号即可连接。' : model.online ? '后台连接继续运行，登录后管理账户与设备。' : '账户连接需要登录；二维码直连可直接使用。';
  $('account-summary-detail').textContent = detail;
  $('sheet-account-status').textContent = detail;
  show('header-login-button', !model.authenticated || model.loginRequired);
  show('sheet-login-button', !model.authenticated || model.loginRequired);
  show('logout-button', model.authenticated);
  show('logout-note', model.authenticated);
  $('logout-note').textContent = model.direct ? '退出桌面账户会清除桌面登录信息，当前直连继续运行。' : '退出桌面账户后，已绑定手机的后台连接继续运行。';
  show('sheet-account-connect', model.direct && model.authenticated);
  show('account-connect-button', !model.authenticated || model.direct || model.loginRequired);
  $('account-connect-button').textContent = model.authenticated && model.direct ? '恢复账户连接' : '登录 khLink 账号';
  show('membership-details', model.authenticated && !model.direct && Boolean(accountData));
  show('effective-badge', model.authenticated && !model.direct);
}

// A computer that joined an account waits for one of the account's other
// computers to hand it the key. Name them, and say what to do when that
// computer is gone (reinstalled, replaced, a throwaway sandbox).
function waitingForKeyDetail() {
  const names = (desktopState?.keyHolders || []).filter(Boolean);
  const which = names.length ? `“${names.join('”、“')}”` : '账号里的另一台电脑';
  return `正在等${which}上的 khLink 在线后交出账户密钥。如果那台电脑已经不用了，在下方“账户设备”里解除它的绑定，这台电脑会自动接管。`;
}

function renderConnector() {
  const connector = desktopState?.connector || {};
  const model = KhConnection.view(desktopState);
  const { direct, online } = model;
  const version = String(connector.version || '未知版本');
  const refreshError = connector.desktopRefresh?.lastError;
  const wasOnline = $('connector-dot').classList.contains('online');
  $('connector-dot').classList.toggle('online', online);
  $('connection-strip').classList.toggle('online', online);
  $('connector-title').textContent = model.title;
  $('connection-heading').textContent = model.title;
  $('connection-mode-label').textContent = direct ? '二维码直连' : '账户连接';
  $('transport-diagnostic').textContent = direct ? '二维码直连' : '账户连接';
  $('server-label').textContent = direct ? '设备直接通信' : '账户服务';
  $('refresh-button').textContent = model.action;
  $('connector-detail').textContent = direct ? (online ? '消息、历史和文件通过两端加密通道传输。' : model.running ? '本机后台已准备好，配对手机后开始直连。' : '点击“配对手机”准备本机后台。') :
    model.loginRequired ? (online ? '手机后台连接仍在运行，登录桌面账户后可管理账户与设备。' : '请登录 khLink 账号，手机也使用同一账号。') : online ? (refreshError ? `桌面刷新异常：${refreshError}` : '电脑已连接账户服务，手机可同步和控制工作区。') : model.waitingForKey ? waitingForKeyDetail() : '点击“重新连接”恢复账户连接。';
  $('connector-diagnostic').textContent = model.running ? `运行中 · v${version}` : '未运行';
  $('relay-diagnostic').textContent = direct ? '直连期间停用' : online ? '已连接' : model.loginRequired ? '需要登录' : '等待连接';
  $('account-mode-button').setAttribute('aria-pressed', String(!direct));
  $('direct-button').setAttribute('aria-pressed', String(direct));
  $('devices-heading').textContent = direct ? '直连手机' : '账户设备';
  $('device-hint').textContent = direct ? '手机扫描电脑连接码后自动连接。' : '手机登录同一账户即可连接；也可使用下方账户配对码。';
  show('account-pairing-action', !direct && model.authenticated && !model.loginRequired);
  show('direct-device-actions', direct);
  $('direct-repair-button').textContent = online ? '查看直连' : '配对手机';
  $('direct-server-button').textContent = model.authenticated ? '恢复账户连接' : '登录并使用账户连接';
  $('autostart-toggle').checked = desktopState?.autostart || false;
  $('sheet-autostart-toggle').checked = desktopState?.autostart || false;
  if (direct) {
    setDeviceText($('device-count'), online ? '1 台手机' : '等待手机');
    showDeviceMessage(online ? '手机已通过加密通道直连，可在手机端操作工作区。' : '生成二维码，连接你的手机。');
  } else if (accountData) {
    renderDevices(accountData.devices || []);
  } else {
    setDeviceText($('device-count'), model.authenticated ? '读取中' : '未登录');
    showDeviceMessage(model.authenticated ? '正在读取账户设备…' : '登录账户后查看已绑定的手机。');
  }
  if (wasOnline !== online) animateStatusChange();
}

// The combined installer's connector updates itself from the signed manifest;
// a newer desktop console is offered as a download.
function renderUpdate() {
  const connector = updateInfo?.bundled && updateInfo.available;
  const desktop = updateInfo?.desktop?.available && updateInfo.desktop.url;
  show('update-row', Boolean(connector || desktop || updateBusy));
  // What the offered version changes, from the signed manifest.
  const notes = updateNotes(connector ? updateInfo.notes : desktop ? updateInfo.desktop.notes : '');
  $('update-notes').replaceChildren(...notes.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
  show('update-notes', !updateBusy && notes.length > 0);
  if (updateBusy) {
    $('update-label').textContent = updateBusyKind === 'desktop' ? '正在下载并校验桌面安装包…' : '正在更新连接器…';
    $('update-button').disabled = true;
    return;
  }
  $('update-button').disabled = false;
  if (connector) {
    $('update-label').textContent = `连接器 ${updateInfo.installed} → ${updateInfo.latest}`;
    $('update-button').textContent = '更新';
  } else if (desktop) {
    $('update-label').textContent = `桌面端 ${updateInfo.desktop.latest} 可下载`;
    $('update-button').textContent = '下载';
  }
  if (updateCheckFailed && (connector || desktop)) $('update-label').textContent += '（上次结果，检查失败）';
}

function updateNotes(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
}

async function checkUpdates(manual = false) {
  if (updateCheckBusy) {
    if (manual) toast('正在检查更新，请稍候');
    return;
  }
  updateCheckBusy = true;
  updateCheckStartedAt = Date.now();
  $('check-updates-button').disabled = true;
  $('check-updates-button').textContent = '正在检查…';
  try {
    updateInfo = await invoke('connector_update_check');
    updateCheckFailed = false;
    if (manual) toast((updateInfo?.bundled && updateInfo.available) || (updateInfo?.desktop?.available && updateInfo.desktop.url) ? '发现可用更新' : '当前已是最新版本');
  } catch {
    // A transient outage must not silently discard an already found update.
    updateCheckFailed = true;
    if (manual) toast('检查更新失败，请检查网络后重试');
  } finally {
    updateCheckBusy = false;
    $('check-updates-button').disabled = false;
    $('check-updates-button').textContent = '检查更新';
    renderUpdate();
  }
}

async function runUpdate() {
  if (updateBusy || !updateInfo) return;
  if (!(updateInfo.bundled && updateInfo.available)) {
    if (!updateInfo.desktop?.url) return;
    updateBusy = true;
    updateBusyKind = 'desktop';
    renderUpdate();
    try {
      const result = await invoke('desktop_update_download');
      toast(`安装包已下载到系统下载文件夹：${result.fileName}`);
    } catch (error) {
      toast(String(error));
    } finally {
      updateBusy = false;
      updateBusyKind = null;
      renderUpdate();
    }
    return;
  }
  updateBusy = true;
  updateBusyKind = 'connector';
  renderUpdate();
  try {
    const result = await invoke('connector_update_apply');
    toast(result.updated ? `连接器已更新到 ${result.installed}` : '连接器已是最新版本');
  } catch (error) {
    toast(String(error));
  } finally {
    updateBusy = false;
    updateBusyKind = null;
    await checkUpdates();
  }
}

let sharedKeyCheckedAt = 0;

function startConnectorPolling() {
  if (connectorTimer) return;
  const poll = async () => {
    if (connectorPollBusy) return;
    connectorPollBusy = true;
    try {
      applyDesktopState(await invoke('get_state'));
      // Polling only reflects the current state. Automatic recovery is
      // intentionally disabled; use the explicit "重新连接" action when
      // the user wants to start the local connector. The one exception: a
      // computer that joined an account waits for its shared key and starts
      // its connector as soon as another computer has handed it over.
      if (desktopState?.awaitingSharedKey && Date.now() - sharedKeyCheckedAt > 15_000) {
        sharedKeyCheckedAt = Date.now();
        const result = await invoke('ensure_connector').catch(() => null);
        if (result && !result.keyPending) { toast('账户连接已建立，这台电脑开始同步'); applyDesktopState(await invoke('get_state')); }
      }
    } catch {
      // Keep the last known state; the stale-heartbeat check will mark it offline.
      renderConnector();
    } finally {
      connectorPollBusy = false;
    }
  };
  connectorTimer = setInterval(poll, 4_000);
  poll();
}

async function refreshConnector() {
  const model = KhConnection.view(desktopState);
  if (model.direct) { await openDirect(); return; }
  if (model.loginRequired) { openLogin(); return; }
  const button = $('refresh-button');
  button.disabled = true;
  button.textContent = '正在连接';
  try {
    await invoke('ensure_connector');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    applyDesktopState(await invoke('get_state'));
  } catch (error) {
    if (/401|revoked|尚未登录/i.test(String(error))) { await load(); openLogin('登录已过期，请重新授权。'); }
    else toast(`连接器启动失败：${error}`);
  } finally {
    button.disabled = false;
    renderConnector();
  }
}

async function loadAccount({ retry = true } = {}) {
  if (!desktopState?.authenticated || KhConnection.view(desktopState).direct) return;
  if (accountLoadBusy) return;
  accountLoadBusy = true;
  const epoch = accountEpoch;
  try {
    const result = await invoke('account');
    if (epoch !== accountEpoch) return;
    accountData = result;
    accountLoadAttempt = 0;
    const profile = accountData.profile || {};
    const name = profile.displayName || 'khLink 用户';
    $('avatar').textContent = initials(name);
    $('sheet-avatar').textContent = initials(name);
    $('account-name').textContent = name;
  $('nav-account-name').textContent = name;
    $('account-subject').textContent = `账号 ID ${profile.khQuantSubject || ''}`;
    const entries = Object.fromEntries((accountData.entitlements || []).map((item) => [item.product, item]));
    const quant = entries.khquant || {};
    const link = entries.kh_link || {};
    // A new account never had khQuant VIP, yet the site reports "expired" with
    // no end date: that is "未开通", not "已到期".
    $('khquant-state').textContent = stateLabel(quant.state === 'expired' && !quant.expiresAt ? '' : quant.state);
    $('khquant-expiry').textContent = expiryLabel(quant.expiresAt, '会员不限 khLink 流量');
    $('khlink-state').textContent = stateLabel(link.state === 'expired' && !link.expiresAt ? '' : link.state);
    $('khlink-expiry').textContent = expiryLabel(link.expiresAt, '');
    // khLink is free (2026-11-06) and its VIP is no longer sold: the row shows
    // only for an account that still holds one.
    $('khlink-row').classList.toggle('hidden', !link.state);
    const effective = accountData.effectiveEntitlement || {};
    $('effective-badge').textContent = effective.canWrite ? `khLink 可用 · ${sourceLabel(effective.source)}` : '当前只读';
    $('effective-badge').classList.toggle('inactive', !effective.canWrite);
    renderDevices(accountData.devices || []);
    renderAccount();
  } catch (error) {
    if (epoch !== accountEpoch) return;
    $('device-count').textContent = '暂不可用';
    $('effective-badge').textContent = '账户状态不可用';
    $('effective-badge').classList.add('inactive');
    // A revoked/expired session cannot be fixed by "重新连接" (that only restarts
    // the local connector). Drop back to the login screen so the user can sign in
    // again instead of staring at a dead dashboard.
    if (/\b401\b|revoked|unauthorized|尚未登录/i.test(String(error))) {
      clearTimeout(accountRetryTimer); accountRetryTimer = null;
      accountLoadAttempt = 0;
      await load();
      openLogin('登录已过期，请重新登录。');
      return;
    }
    toast(`账户状态读取失败：${String(error)}`);
    if (retry && accountLoadAttempt < 3) {
      accountLoadAttempt += 1;
      clearTimeout(accountRetryTimer);
      accountRetryTimer = setTimeout(() => {
        accountRetryTimer = null;
        loadAccount({ retry: true });
      }, 2_500);
    }
  } finally {
    accountLoadBusy = false;
  }
}

function sourceLabel(source) {
  return ({ khquant: 'khQuant VIP', kh_link: 'khLink VIP', combined: '双重权益' })[source] || '免费额度';
}

function setDeviceText(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}

function showDeviceMessage(message) {
  const target = $('device-list');
  if (deviceListMode !== 'message' || target.textContent !== message) target.textContent = message;
  deviceListMode = 'message';
  deviceRows.clear();
}

function createDeviceRow(device, type) {
  const row = document.createElement('div');
  row.className = 'device-row weui-cell';
  const icon = document.createElement('div');
  icon.className = 'device-icon weui-cell__hd';
  const copy = document.createElement('div');
  copy.className = 'device-copy weui-cell__bd';
  const strong = document.createElement('strong');
  const detail = document.createElement('span');
  copy.append(strong, detail);
  row.append(icon, copy);
  const record = { row, icon, strong, detail, type, device };
  if (['android', 'desktop', 'connector'].includes(type)) {
    const revoke = document.createElement('button');
    revoke.className = 'text-button';
    revoke.textContent = '解除绑定';
    // Read the current device, not the object captured by an earlier poll.
    revoke.addEventListener('click', async () => {
      const current = record.device;
      const kind = type === 'android' ? '手机' : '电脑';
      if (!confirm(`解除 ${current.name} 的绑定后，这台${kind}需要重新登录或扫码才能连接。`)) return;
      try { await invoke('revoke_device', { deviceId: current.id }); await loadAccount(); } catch (error) { toast(String(error)); }
    });
    row.append(revoke);
  }
  return record;
}

function renderDevices(devices) {
  const target = $('device-list');
  const localDesktopId = String(desktopState?.deviceId || '');
  const localConnectorId = localDesktopId ? `${localDesktopId}.connector` : '';
  const active = devices
    .filter((device) => {
      const type = String(device.type || '').toLowerCase();
      const id = String(device.id || '');
      const local = device.local === true || id === localDesktopId || id === localConnectorId;
      return !device.revokedAt && !local && ['android', 'desktop', 'connector'].includes(type);
    });
  setDeviceText($('device-count'), `${active.length} 个设备`);
  if (!active.length) { showDeviceMessage('还没有已绑定设备'); return; }
  if (deviceListMode !== 'rows') { target.replaceChildren(); deviceRows.clear(); deviceListMode = 'rows'; }
  const previousOrder = new Map(Array.from(target.children, (row, index) => [row, index]));
  const occurrences = new Map();
  const keyed = active.map((device, index) => {
    const id = String(device.id || '');
    const base = id ? `id:${id}` : `missing:${index}`;
    const count = occurrences.get(base) || 0;
    occurrences.set(base, count + 1);
    return { device, key: `${base}:${count}`, index };
  });
  // Keep the existing order among devices with the same online state even if
  // the server returns them in a different order on the next refresh.
  keyed.sort((a, b) => Number(b.device.online === true) - Number(a.device.online === true) ||
    (previousOrder.get(deviceRows.get(a.key)?.row) ?? Infinity) - (previousOrder.get(deviceRows.get(b.key)?.row) ?? Infinity) || a.index - b.index);
  const wanted = new Set(keyed.map(({ key }) => key));
  for (const [key, record] of deviceRows) if (!wanted.has(key)) { record.row.remove(); deviceRows.delete(key); }
  keyed.forEach(({ device, key }, index) => {
    const type = String(device.type || '').toLowerCase();
    let record = deviceRows.get(key);
    if (record && record.type !== type) { record.row.remove(); deviceRows.delete(key); record = null; }
    if (!record) { record = createDeviceRow(device, type); deviceRows.set(key, record); }
    record.device = device;
    setDeviceText(record.icon, type === 'android' ? 'M' : 'C');
    setDeviceText(record.strong, device.name);
    const typeLabel = type === 'android' ? 'Android 手机' : type === 'connector' ? '电脑连接器' : '桌面客户端';
    const shortId = String(device.id || '').slice(-6);
    setDeviceText(record.detail, `${typeLabel} · ${device.online === true ? '在线' : '已绑定'}${shortId ? ` · ${shortId}` : ''}`);
    if (target.children[index] !== record.row) target.insertBefore(record.row, target.children[index] || null);
  });
}

function formatTokens(value) {
  const number = Number(value || 0);
  return number.toLocaleString('zh-CN');
}

function renderUsage(usageData) {
  const values = usageData || {};
  const total = formatTokens(values.totalTokens);
  const input = formatTokens(values.inputTokens);
  const output = formatTokens(values.outputTokens);
  const reasoning = formatTokens(values.reasoningOutputTokens);
  const cache = formatTokens(values.cachedInputTokens);
  ['usage-total', 'dashboard-usage-total'].forEach((id) => { if ($(id)) $(id).textContent = total; });
  ['usage-input', 'dashboard-usage-input'].forEach((id) => { if ($(id)) $(id).textContent = input; });
  ['usage-output', 'dashboard-usage-output'].forEach((id) => { if ($(id)) $(id).textContent = output; });
  ['usage-reasoning', 'dashboard-usage-reasoning'].forEach((id) => { if ($(id)) $(id).textContent = reasoning; });
  ['usage-cache', 'dashboard-usage-cache'].forEach((id) => { if ($(id)) $(id).textContent = cache; });
  if ($('usage-sessions')) $('usage-sessions').textContent = `${formatTokens(values.sessionCount)} 个会话`;
  const updated = Number(values.updatedAt || 0);
  const label = updated ? `更新于 ${new Date(updated).toLocaleTimeString('zh-CN', { hour12: false })}` : '暂无数据';
  if ($('usage-updated-dashboard')) $('usage-updated-dashboard').textContent = label;
  // No Codex session on this PC (Codex not installed or never used): the
  // usage cards would only show zeros, so leave them out.
  const none = usageData && Number(values.updatedAt || 0) > 0 && !Number(values.sessionCount || 0);
  document.querySelectorAll('.usage-dashboard-panel, .usage-card, .usage-note').forEach((el) => el.classList.toggle('hidden', none));
}

// Returning from the tray or another window should not leave a six-hour-old
// release offer on screen. Coalesce focus/visibility events and limit retries.
function refreshWhenVisible() {
  if (document.hidden) return;
  if (Date.now() - updateCheckStartedAt >= UPDATE_FOCUS_CHECK_INTERVAL_MS) checkUpdates();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadUsage(); refreshWhenVisible(); } });
window.addEventListener('focus', refreshWhenVisible);

async function loadUsage() {
  if (usageLoadBusy || !desktopState || document.hidden) return;
  usageLoadBusy = true;
  try { renderUsage(await invoke('usage')); }
  catch { renderUsage({}); }
  finally { usageLoadBusy = false; }
}

function renderDiagnostics(data) {
  const current = data?.current || {};
  const age = data?.heartbeatAgeMs == null ? '未知' : `${Math.max(0, Math.floor(Number(data.heartbeatAgeMs) / 1000))} 秒前`;
  const currentOnline = Boolean(current.connected || current.online) && Number(data?.heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER) <= 15_000;
  $('diagnostic-current').textContent = currentOnline ? `在线 · ${age}` : `异常 · ${age}`;
  $('diagnostic-version').textContent = `v${current.version || '未知'} · ${current.lifecycle || '未知'}`;
  $('diagnostic-threads').textContent = `${Array.isArray(current.activeThreads) ? current.activeThreads.length : 0} 个活动任务`;
  const checks = $('diagnostic-checks');
  checks.replaceChildren();
  (data?.checks || []).forEach((check) => {
    const row = document.createElement('div');
    row.className = `diagnostic-check ${check.ok ? 'ok' : 'bad'}`;
    row.innerHTML = `<span>${check.ok ? '✓' : '!'}</span><div><strong>${check.name}</strong><small>${check.message}</small></div>`;
    checks.append(row);
  });
  const entries = $('diagnostic-log');
  entries.replaceChildren();
  const list = (data?.entries || []).slice().reverse();
  if (!list.length) entries.textContent = '暂时没有异常记录';
  list.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `diagnostic-entry ${entry.level || 'info'}`;
    const at = entry.at ? new Date(Number(entry.at)).toLocaleString('zh-CN', { hour12: false }) : '';
    row.innerHTML = `<time>${at}</time><span>${entry.message || entry.kind || '连接状态变化'}</span>`;
    entries.append(row);
  });
}

async function loadDiagnostics() {
  if (diagnosticsLoadBusy) return;
  diagnosticsLoadBusy = true;
  $('diagnostic-refresh').disabled = true;
  try {
    const [diagnosticsResult, usageResult] = await Promise.allSettled([invoke('diagnostics'), invoke('usage')]);
    if (diagnosticsResult.status !== 'fulfilled') throw diagnosticsResult.reason;
    renderDiagnostics(diagnosticsResult.value);
    if (usageResult.status === 'fulfilled') renderUsage(usageResult.value);
    else { renderUsage({}); toast('用量暂时不可用，诊断信息仍可查看'); }
    show('diagnostics-dialog');
    animateReveal('diagnostics-dialog', '.diagnostics-dialog');
  } catch (error) { toast(`诊断读取失败：${error}`); }
  finally { diagnosticsLoadBusy = false; $('diagnostic-refresh').disabled = false; }
}

function openLogin(message = '账号密码只在 khsci.com 网页上填写。') {
  show('account-sheet', false);
  show('login-mode-note', KhConnection.view(desktopState).direct);
  if (!loginBusy) { $('login-status').textContent = message; $('login-button').disabled = false; }
  show('login-view');
  animateReveal('login-view', '.login-panel');
}

async function closeLogin() {
  ++loginEpoch;
  clearTimeout(loginTimer); loginTimer = null; loginBusy = false;
  $('login-button').disabled = false;
  try { await invoke('cancel_login'); } catch (error) { toast(String(error)); }
  show('login-view', false);
}

async function useAccountConnection() {
  if (accountConnectionBusy) return;
  const model = KhConnection.view(desktopState);
  if (!model.authenticated || model.loginRequired) { openLogin(); return; }
  accountConnectionBusy = true;
  for (const id of ['account-mode-button', 'account-connect-button', 'sheet-account-connect', 'direct-server-button']) $(id).disabled = true;
  show('account-sheet', false);
  try {
    await invoke('ensure_connector');
    await load();
    if (!accountData) await loadAccount({ retry: false });
  } catch (error) {
    if (/401|revoked|尚未登录/i.test(String(error))) { await load(); openLogin('账户登录已过期，请重新授权。'); }
    else toast(`账户连接失败：${error}`);
  } finally {
    accountConnectionBusy = false;
    for (const id of ['account-mode-button', 'account-connect-button', 'sheet-account-connect', 'direct-server-button']) $(id).disabled = false;
  }
}

async function beginLogin() {
  if (loginBusy) return;
  loginBusy = true;
  const epoch = ++loginEpoch;
  $('login-button').disabled = true;
  $('login-status').textContent = '正在打开授权页面…';
  const fail = (error) => {
    if (epoch !== loginEpoch) return;
    clearTimeout(loginTimer); loginTimer = null; loginBusy = false;
    $('login-button').disabled = false; $('login-status').textContent = String(error);
  };
  try {
    await invoke('begin_login');
    if (epoch !== loginEpoch) { await invoke('cancel_login'); return; }
    $('login-status').textContent = '请在浏览器中完成授权，然后返回这里。';
    const poll = async () => {
      if (epoch !== loginEpoch) return;
      try {
        const result = await invoke('poll_login');
        if (epoch !== loginEpoch) return;
        if (result.status === 'complete') {
          loginBusy = false; loginTimer = null; $('login-button').disabled = false;
          show('login-view', false);
          accountEpoch++; accountData = null; accountLoadAttempt = 0;
          await load();
          toast(result.connectorError ? `账户已登录，连接尚未恢复：${result.connectorError}` : '账户登录成功');
          return;
        }
        loginTimer = setTimeout(poll, 900);
      } catch (error) { fail(error); }
    };
    loginTimer = setTimeout(poll, 900);
  } catch (error) { fail(error); }
}

async function createPairing() {
  try {
    pairing = await invoke('create_pairing');
    $('qr-code').innerHTML = pairing.qrSvg;
    $('pairing-status').textContent = '等待手机扫描';
    show('pairing-request', false);
    show('pairing-dialog');
    animateReveal('pairing-dialog', '.pairing-dialog');
    if (motion && !reduceMotion) motion.from('#qr-code', { autoAlpha: 0, scale: 0.92, duration: 0.4, delay: 0.08, ease: 'back.out(1.4)' });
    clearInterval(pairingTimer);
    pairingTimer = setInterval(updatePairing, 900);
    updateCountdown();
  } catch (error) { toast(String(error)); }
}

function closePairingDialog() {
  clearInterval(pairingTimer);
  pairingTimer = null;
  pairingPollBusy = false;
  pairing = null;
  show('pairing-request', false);
  show('pairing-dialog', false);
}

async function updatePairing() {
  if (!pairing || pairingPollBusy) return;
  updateCountdown();
  if (Date.now() >= pairing.expiresAt) {
    clearInterval(pairingTimer);
    $('pairing-status').textContent = '二维码已失效，请重新生成';
    return;
  }
  pairingPollBusy = true;
  try {
    const status = await invoke('pairing_status', { id: pairing.id });
    if (status.status === 'pending') {
      $('pairing-device').textContent = status.deviceName || 'Android 手机';
      const wasHidden = $('pairing-request').classList.contains('hidden');
      show('pairing-request');
      if (wasHidden) animateReveal('pairing-request');
      $('pairing-status').textContent = '请核对设备后确认';
    } else if (status.status === 'confirmed' || status.status === 'consumed') {
      $('pairing-status').textContent = status.status === 'consumed' ? '手机已完成绑定' : '已确认，等待手机完成';
      if (status.status === 'consumed') { closePairingDialog(); await loadAccount(); }
    }
  } catch (error) { $('pairing-status').textContent = String(error); }
  finally { pairingPollBusy = false; }
}

function updateCountdown() {
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
  $('pairing-countdown').textContent = `二维码将在 ${seconds} 秒后失效`;
}

async function setAutostart(enabled) {
  try {
    const value = await invoke('set_autostart', { enabled });
    desktopState.autostart = value;
    $('autostart-toggle').checked = value;
    $('sheet-autostart-toggle').checked = value;
  } catch (error) {
    $('autostart-toggle').checked = desktopState?.autostart || false;
    $('sheet-autostart-toggle').checked = desktopState?.autostart || false;
    toast(String(error));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // The version comes from the app itself (tauri.conf.json), so it never goes stale.
  window.__TAURI__.app.getVersion().then((version) => {
    $('desktop-version').textContent = version;
    $('desktop-version-footer').textContent = version;
  }).catch(() => {});
  $('login-button').addEventListener('click', beginLogin);
  $('header-login-button').addEventListener('click', () => openLogin());
  $('sheet-login-button').addEventListener('click', () => openLogin());
  $('login-close').addEventListener('click', closeLogin);
  $('login-cancel').addEventListener('click', closeLogin);
  for (const id of ['account-mode-button', 'account-connect-button', 'sheet-account-connect', 'direct-server-button']) $(id).addEventListener('click', useAccountConnection);
  $('refresh-button').addEventListener('click', refreshConnector);
  $('diagnostics-button').addEventListener('click', loadDiagnostics);
  $('diagnostic-refresh').addEventListener('click', loadDiagnostics);
  $('diagnostic-clear').addEventListener('click', async () => {
    try { await invoke('clear_diagnostics'); await loadDiagnostics(); toast('诊断日志已清空'); }
    catch (error) { toast(String(error)); }
  });
  $('pair-button').addEventListener('click', createPairing);
  $('account-button').addEventListener('click', () => { show('account-sheet'); animateReveal('account-sheet', '.sheet'); });
  $('sheet-devices').addEventListener('click', () => {
    show('account-sheet', false);
    window.KhProfiles?.navigate('remote');
    $('devices-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('confirm-pairing').addEventListener('click', async () => {
    const button = $('confirm-pairing');
    button.disabled = true;
    $('pairing-status').textContent = '正在确认设备';
    try { await invoke('confirm_pairing', { id: pairing.id }); show('pairing-request', false); $('pairing-status').textContent = '已确认，等待手机完成绑定'; }
    catch (error) { toast(String(error)); button.disabled = false; }
  });
  $('logout-button').addEventListener('click', async () => {
    try { await closeLogin(); await invoke('logout'); accountEpoch++; accountData = null; show('account-sheet', false); await load(); }
    catch (error) { toast(String(error)); }
  });
  $('update-button').addEventListener('click', runUpdate);
  $('check-updates-button').addEventListener('click', () => checkUpdates(true));
  $('autostart-toggle').addEventListener('change', (event) => setAutostart(event.target.checked));
  $('sheet-autostart-toggle').addEventListener('change', (event) => setAutostart(event.target.checked));
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.close === 'pairing-dialog') closePairingDialog();
    else show(button.dataset.close, false);
  }));
  document.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => invoke('open_external', { url: button.dataset.url }).catch((error) => toast(String(error)))));
  load();
  checkUpdates();
  setInterval(checkUpdates, UPDATE_CHECK_INTERVAL_MS);
});
