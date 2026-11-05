// The phone returns its encrypted answer automatically after one scan.
let directView = null;
let directPoll = null;
let directPollBusy = false;
let directOperationBusy = false;
let directEpoch = 0;
let directQrId = null;

async function openDirect() {
  show('account-sheet', false); show('direct-dialog'); ++directEpoch;
  $('direct-mode-note').textContent = KhConnection.view(desktopState).direct ?
    '手机扫码后自动连接。断开后可重新扫码，或返回账户连接。' : '生成二维码时保留账户连接，手机扫码并完成认证后自动切换为直连；账户连接在后台待命，直连连不上时手机可改用账号登录。';
  await pollDirect(true);
  if (['idle', 'failed', 'expired'].includes(directView?.status)) await generateDirect();
  if (!directPoll) directPoll = setInterval(pollDirect, 1000);
}

async function closeDirect() {
  ++directEpoch; clearInterval(directPoll); directPoll = null; show('direct-dialog', false);
  try {
    // The phone may finish between the last UI poll and closing the window.
    const current = await invoke('direct_status');
    if (!current.connected && current.status !== 'connecting') { await invoke('direct_cancel'); directQrId = null; }
  } catch { /* No pairing exists before the connector starts. */ }
  await load();
}

function renderDirect(value) {
  directView = value;
  const waiting = value.status === 'waiting';
  const connected = value.status === 'connected' && value.connected;
  const labels = { idle: '打开手机 khLink，扫描电脑连接码即可。', gathering: '正在生成电脑连接码…',
    waiting: '请用手机 khLink 扫描这个二维码，随后会自动连接。',
    connecting: '已收到手机握手，正在自动建立加密直连…', connected: `已直连 ${value.phoneName || '手机'}，消息和文件直接传输。`,
    expired: '二维码已过期，请重新生成。', failed: value.error || '直连未成功，请重新扫码或使用账户连接。' };
  $('direct-status').textContent = labels[value.status] || labels.idle;
  if (waiting && value.singleScan === false) $('direct-status').textContent = '请更新电脑连接器和手机端，然后重新生成二维码。';
  $('direct-dialog').querySelector('.direct-dialog').classList.toggle('connected', connected);
  $('direct-step-1').classList.toggle('active', waiting || value.status === 'gathering');
  $('direct-step-2').classList.toggle('active', value.status === 'connecting');
  $('direct-step-3').classList.toggle('active', connected);
  $('direct-copy').disabled = !waiting || !value.payload;
  $('direct-generate').disabled = directOperationBusy || value.status === 'connecting';
  $('direct-stun').disabled = directOperationBusy || value.status === 'connecting';
  $('direct-generate').textContent = waiting ? '重新生成连接码' : '生成电脑连接码';
  show('direct-cancel', !connected); show('direct-done', connected); show('direct-disconnect', connected);
  if (value.qrSvg && waiting) { $('direct-qr').innerHTML = value.qrSvg; directQrId = value.id; }
  if (!waiting && value.status !== 'gathering') {
    directQrId = null; $('direct-qr').textContent = connected ? '连接已完成' : '正在连接手机';
  }
  $('direct-countdown').textContent = waiting ? `连接码剩余 ${Math.max(0, Math.ceil((value.expiresAt - Date.now()) / 1000))} 秒` : '';
}

async function pollDirect(qr = false) {
  if (directPollBusy || directOperationBusy) return;
  directPollBusy = true; const epoch = directEpoch;
  try {
    let value = await invoke('direct_status', { qr: qr === true });
    if (epoch !== directEpoch) return;
    if (value.status === 'waiting' && value.id !== directQrId && !value.qrSvg) value = await invoke('direct_status', { qr: true });
    if (epoch !== directEpoch || directOperationBusy) return;
    const changed = directView?.status !== value.status || value.mode !== desktopState?.connectionMode;
    renderDirect(value); if (changed) await load();
  } catch {
    if (epoch === directEpoch) { renderDirect({ status: 'idle' }); $('direct-status').textContent = '生成二维码会自动准备本机后台。'; }
  } finally { directPollBusy = false; }
}

async function generateDirect() {
  if (directOperationBusy) return;
  directOperationBusy = true; const epoch = directEpoch; renderDirect({ status: 'gathering' });
  try {
    const value = await invoke('direct_begin', { stun: $('direct-stun').checked });
    if (epoch !== directEpoch) return;
    directOperationBusy = false; renderDirect(value); await load();
  } catch (error) {
    if (epoch === directEpoch) { directOperationBusy = false; renderDirect({ status: 'failed', error: String(error) }); }
  } finally { directOperationBusy = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  for (const id of ['direct-button', 'direct-repair-button']) $(id).addEventListener('click', openDirect);
  $('direct-generate').addEventListener('click', generateDirect); $('direct-stun').addEventListener('change', generateDirect);
  for (const id of ['direct-close', 'direct-done']) $(id).addEventListener('click', closeDirect);
  $('direct-cancel').addEventListener('click', async () => {
    ++directEpoch; clearInterval(directPoll); directPoll = null;
    try { await invoke('direct_cancel'); show('direct-dialog', false); await load(); }
    catch (error) { $('direct-status').textContent = String(error); }
  });
  $('direct-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(directView.payload); toast('已复制电脑连接信息'); }
    catch { toast('复制失败，请使用二维码'); }
  });
  $('direct-disconnect').addEventListener('click', async () => {
    if (directOperationBusy) return;
    try { renderDirect(await invoke('direct_cancel')); await load(); }
    catch (error) { $('direct-status').textContent = String(error); }
  });
});
