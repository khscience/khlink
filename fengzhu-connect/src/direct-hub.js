const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { RTCPeerConnection } = require('werift');
const { protect } = require('./config');
const { encryptJson, decryptJson, blobFields } = require('./crypto');
const { encodeQr, decodeQr, verifyAnswer, FramedChannel, trimOfferSdp } = require('./direct-protocol');
const { DirectSignaling, usableAddresses } = require('./direct-signaling');
const { DirectPairs, DirectResume } = require('./direct-resume');
const { encodeCompactOffer } = require('./direct-compact');
const { DirectTunnel } = require('./direct-tunnel');

const RESUME_OFFER_MS = 60_000;
const RESUME_AGE_MS = 120_000;
const UUID = /^[a-f0-9-]{36}$/i;

function channelOpen(channel, timeout = 5000) {
  if (!channel || channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscription?.unSubscribe?.(); reject(new Error('直连通道没有打开')); }, timeout);
    const subscription = channel.stateChange?.subscribe((state) => {
      if (state === 'open') { clearTimeout(timer); subscription?.unSubscribe?.(); resolve(); }
    });
    if (!subscription) { clearTimeout(timer); resolve(); }
  });
}

class DirectHub {
  constructor(connector, options = {}) {
    this.connector = connector; this.options = options; this.session = null;
    this.generation = 0;
    this.controlSecret = crypto.randomBytes(32).toString('base64url');
    this.controlFile = path.join(path.dirname(connector.config.configFile), 'direct-control.json');
    this.pairs = options.pairs || new DirectPairs(path.join(path.dirname(connector.config.configFile), 'direct-pairs.json'));
    this.resume = new DirectResume(this, options.resume);
    this.tunnel = options.tunnel || new DirectTunnel({ accept: (target, channel, control) => this.acceptTunnel(target, channel, control),
      log: (message) => connector.log?.(message), stateFile: path.join(path.dirname(connector.config.configFile), 'direct-tunnel.json') });
    this.tunnelSeen = new Map();
  }
  // Paired phones reconnect over the LAN only while this computer is in direct
  // mode. The cross-network tunnel, once opened, stays up for them as well,
  // also across a connector restart: the new connector takes it over.
  async syncResume() {
    if (this.connector.config.directOnly && this.pairs.list().length) {
      try { await this.resume.start(); } catch (error) { this.connector.log?.(error); }
      try { await this.tunnel.reattach?.(); } catch (error) { this.connector.log?.(error); }
    } else { this.resume.stop(); if (!this.pairingInProgress()) this.tunnel.stop(); }
  }
  pairingInProgress() { const session = this.session; return Boolean(session && !session.authenticated && ['gathering', 'waiting', 'connecting'].includes(session.status)); }
  get connected() { return this.session?.authenticated === true && this.session.channel?.readyState === 'open'; }
  status() {
    const session = this.session;
    return { mode: this.connector.config.directOnly ? 'direct' : 'server', connected: this.connected,
      id: session?.id, status: session?.status || 'idle', expiresAt: session?.expiresAt,
      payload: session?.resumeDeviceId ? undefined : session?.payload, phoneName: session?.name, stun: session?.stun, singleScan: Boolean(session?.signaling), error: session?.error,
      resuming: Boolean(session?.resumeDeviceId && !session.authenticated), pairedPhones: this.pairs.list().map(({ name, lastSeenAt }) => ({ name, lastSeenAt })),
      tunnel: Boolean(session?.tunnelHost), tunnelAvailable: this.tunnel.available, transport: session?.channel?.transport || (session?.authenticated ? 'webrtc' : undefined) };
  }
  async start() {
    this.server = http.createServer((req, res) => this.control(req, res));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const port = this.server.address().port;
    fs.writeFileSync(this.controlFile, JSON.stringify({ port, pid: process.pid, protected: protect(this.controlSecret) }));
    await this.syncResume();
    this.timer = setInterval(() => {
      const session = this.session;
      if (session && !session.authenticated && Date.now() > session.expiresAt) this.end(session.resumeDeviceId ? 'idle' : 'expired', session.resumeDeviceId ? undefined : '二维码已过期，请重新生成');
      if (this.connected) {
        if (Date.now() - (session.lastReceived || 0) > 30_000) { this.fail(session, new Error('手机直连心跳超时，请重新扫码')); return; }
        this.send('connector.presence', null, this.connector.presencePayload());
        if (this.connector.ws?.readyState !== 1) this.connector.republishActiveThreadStatuses();
      }
      this.connector.writeStatus(this.connector.isConnected());
      // An unused tunnel (QR expired or cancelled, nothing paired) is closed.
      if (this.tunnel.running && ++this.tunnelCheck % 15 === 0 && !this.pairingInProgress()
        && !(this.connector.config.directOnly && this.pairs.list().length)) this.tunnel.stop();
    }, 1000);
    this.tunnelCheck = 0;
    this.timer.unref();
  }
  async control(req, res) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const expected = Buffer.from(this.controlSecret); const actual = Buffer.from(token);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected) || req.headers.origin) {
      res.writeHead(403); res.end(JSON.stringify({ error: '本机控制认证失败' })); return;
    }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16000) throw new Error('请求过大'); }
      const args = body ? JSON.parse(body) : {};
      let value;
      if (req.method === 'GET' && req.url === '/status') value = this.status();
      else if (req.method === 'POST' && req.url === '/offer') value = await this.offer(args.stun !== false);
      else if (req.method === 'POST' && req.url === '/answer') value = await this.answer(args.payload);
      else if (req.method === 'POST' && req.url === '/cancel') { await this.end('idle'); value = this.status(); }
      else if (req.method === 'POST' && req.url === '/server') { await this.connector.setDirectMode(false); await this.end('idle'); this.pairs.clear(); await this.syncResume(); value = this.status(); }
      else if (req.method === 'POST' && req.url === '/forget') { this.pairs.clear(); await this.syncResume(); value = this.status(); }
      else { res.writeHead(404); value = { error: '未知的控制请求' }; }
      res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
  }
  // A paired phone asks again after a restart: same key, a fresh offer, no QR.
  async resumeOffer(pair, request) {
    if (!this.connector.config.directOnly) throw new Error('电脑已切换到账户连接，请重新扫码');
    if (request.pcId !== this.connector.config.deviceId) throw new Error('电脑身份与配对记录不匹配');
    const session = this.session;
    if (session?.authenticated && session.deviceId !== pair.deviceId && Date.now() - (session.lastReceived || 0) < 20_000) throw new Error('电脑正在和另一台手机直连');
    if (session && !session.authenticated && session.status === 'waiting' && !session.resumeDeviceId && Date.now() < session.expiresAt) throw new Error('电脑正在显示新的连接码，请扫码连接');
    // UDP retries of the same phone share one offer instead of replacing it.
    if (this.resuming?.deviceId === pair.deviceId) return this.resuming.promise;
    const current = this.session;
    if (current?.resumeDeviceId === pair.deviceId && current.status === 'waiting' && Date.now() < current.expiresAt - 10_000) return current.offerValue;
    const promise = this.offer(false, pair).then(() => this.session.offerValue);
    this.resuming = { deviceId: pair.deviceId, promise };
    try { return await promise; } finally { if (this.resuming?.promise === promise) this.resuming = null; }
  }
  async offer(stun, resume = null) {
    if (this.creating) throw new Error('正在生成连接码，请稍候');
    this.creating = true;
    const generation = ++this.generation;
    try {
      // Preparing an offer must not take an existing account connection offline.
      // A scanned phone returns its authenticated answer automatically.
      await this.end('idle', undefined, false);
      if (generation !== this.generation) throw new Error('配对已取消');
      // No STUN, ever: asking a public STUN server sent this computer's real
      // public address to that server (outside any proxy) and into the QR.
      // Across networks the tunnel carries the link; WebRTC stays on the LAN.
      const crossNetwork = stun; stun = false;
      const peer = this.options.createPeer?.(stun) || new RTCPeerConnection({ iceServers: [], iceUseIpv6: false, maxMessageSize: 16384 });
      const session = { id: crypto.randomUUID(), key: resume?.key || crypto.randomBytes(32).toString('base64'),
        expiresAt: Date.now() + (resume ? RESUME_OFFER_MS : 5 * 60_000), status: 'gathering', stun, peer, seen: new Set(), sequence: 0,
        resumeDeviceId: resume?.deviceId };
      this.session = session;
      const channel = peer.createDataChannel('khlink-direct-v1', { ordered: true }); session.channel = channel;
      session.framed = new FramedChannel(channel, (raw) => this.receive(session, raw).catch((error) => this.fail(session, error)), (error) => this.fail(session, error));
      // Once the phone came in over the tunnel, the WebRTC side closing is expected.
      channel.stateChange.subscribe((state) => { if (state === 'closed' && this.session === session && session.channel === channel) this.fail(session, new Error('直连已断开，请重新扫码')); });
      peer.connectionStateChange.subscribe((state) => {
        const connection = peer.iceTransports?.[0]?.connection; const pair = connection?.nominated;
        console.log(`[fengzhu-connect] direct transport ${state}: receivedAgo=${session.lastReceived ? Date.now() - session.lastReceived : '-'}ms, consent=${connection?.consentFresh}, requests=${pair?.requestsSent}, responses=${pair?.responsesReceived}`);
        if (state === 'failed' && this.session === session && session.channel === channel && !session.tunnelHost) this.fail(session, new Error('网络不支持直连，请换用同一 Wi-Fi／热点或服务器模式'));
      });
      // Not on the same network: open the cross-network tunnel while WebRTC gathers.
      if (crossNetwork && !resume && !this.tunnel.available) throw new Error('缺少跨网络直连组件，请重新安装 khLink 桌面端');
      const tunnelReady = crossNetwork && !resume ? this.tunnel.start() : Promise.resolve(null);
      tunnelReady.catch(() => {});
      await peer.setLocalDescription(await peer.createOffer());
      if (this.session !== session) throw new Error('配对已取消');
      // The same address list feeds the return path and the QR's candidates.
      const addresses = this.options.signaling?.addresses || await usableAddresses();
      session.signaling = new DirectSignaling(session, (payload) => this.answer(payload), { ...this.options.signaling, addresses });
      const signaling = await session.signaling.start(stun);
      session.tunnelHost = await tunnelReady;
      if (this.session !== session) throw new Error('配对已取消');
      const offerValue = { v: 2, id: session.id, expiresAt: session.expiresAt,
        pcId: this.connector.config.deviceId, pcName: this.connector.config.deviceName,
        stun, signaling, sdp: trimOfferSdp(peer.localDescription.sdp, addresses),
        ...(session.tunnelHost ? { tunnel: session.tunnelHost } : {}) };
      // The resume offer travels sealed with the pairing key, never with it.
      if (resume) session.offerValue = offerValue;
      else session.payload = encodeCompactOffer({ ...offerValue, key: session.key }) || encodeQr('offer', { ...offerValue, key: session.key });
      session.status = 'waiting'; return this.status();
    } catch (error) { if (generation === this.generation) await this.end('failed', error.message); throw error; }
    finally { this.creating = false; }
  }
  async answer(payload) {
    const session = this.session;
    if (!session || session.status !== 'waiting' || Date.now() > session.expiresAt) throw new Error('电脑连接码已过期，请重新生成');
    const answer = decodeQr(payload, 'answer');
    if (answer.id !== session.id || !verifyAnswer(session.key, answer)) throw new Error('手机确认码与本次电脑连接码不匹配');
    if (session.resumeDeviceId && answer.deviceId !== session.resumeDeviceId) throw new Error('手机确认码与配对记录不匹配');
    session.status = 'connecting';
    try {
      await this.connector.setDirectMode(true);
      if (this.session !== session) throw new Error('配对已取消，请重新生成连接码');
      session.deviceId = answer.deviceId; session.name = answer.name;
      await session.peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (error) { if (this.session === session) this.fail(session, error); throw error; }
    return this.status();
  }
  // The phone proved it holds the key: remember the pairing, then welcome it.
  async authenticate(session) {
    // Save the pairing before the session counts as connected: the welcome
    // must be the first frame the phone sees, ahead of any presence tick.
    try { this.pairs.remember({ deviceId: session.deviceId, name: session.name, key: session.key }); await this.syncResume(); }
    catch (error) { this.connector.log?.(error); }
    // The phone's first message can arrive while this side still reports the
    // channel as connecting; a welcome sent then would be dropped.
    await channelOpen(session.channel);
    if (this.session !== session) return;
    session.authenticated = true; session.status = 'connected'; session.payload = undefined; session.lastReceived = Date.now();
    this.send('direct.welcome', null, { pcId: this.connector.config.deviceId, pcName: this.connector.config.deviceName,
      resume: this.resume.port ? { port: this.resume.port } : undefined, tunnel: this.tunnel.running ? this.tunnel.host : undefined });
    const via = session.channel?.transport === 'tunnel' ? ' over the tunnel' : '';
    console.log(`[fengzhu-connect] direct phone ${session.resumeDeviceId ? 'reconnected without a scan' : 'paired by QR'}${via}`);
    await this.connector.onFrame(JSON.stringify({ type: 'ready' }), { direct: true });
    this.connector.pushCodexUsage(true).catch((e) => this.connector.log(e));
    this.connector.syncHistory().catch((e) => this.connector.log(e));
  }
  /**
   * A WebSocket arrived through the cross-network tunnel. `target` is the
   * session id from a scanned QR, or "resume" for a paired phone. Nothing is
   * trusted until the first frame opens with the right key.
   */
  acceptTunnel(target, channel, control) {
    let handler;
    const framed = new FramedChannel(channel, (raw) => handler(raw).catch((error) => { control.reject(); this.connector.log?.(error); }), () => control.reject());
    const authenticated = (session) => {
      control.authenticated();
      handler = (raw) => this.receive(session, raw);
      channel.stateChange.subscribe((state) => { if (state === 'closed' && this.session === session && session.channel === channel) this.fail(session, new Error('直连已断开')); });
    };
    if (target === 'resume') {
      handler = async (raw) => {
        handler = async () => {};
        const frame = JSON.parse(raw);
        if (frame.v !== 1 || frame.kind !== 'direct.resume' || !UUID.test(frame.id || '') || !UUID.test(frame.deviceId || '')) throw new Error('无效的重连请求');
        const pair = this.pairs.get(frame.deviceId);
        if (!pair) throw new Error('未配对的手机');
        const request = decryptJson(pair.key, { ...frame, threadId: null });
        const now = Date.now();
        for (const [id, at] of this.tunnelSeen) if (now - at > RESUME_AGE_MS * 2) this.tunnelSeen.delete(id);
        if (this.tunnelSeen.has(frame.id) || request.deviceId !== frame.deviceId || Math.abs(now - Number(request.sentAt)) > RESUME_AGE_MS) throw new Error('重连请求已失效');
        this.tunnelSeen.set(frame.id, now);
        if (!this.connector.config.directOnly || request.pcId !== this.connector.config.deviceId) throw new Error('电脑已不在直连模式');
        const current = this.session;
        if (current?.authenticated && current.deviceId !== pair.deviceId && now - (current.lastReceived || 0) < 20_000) throw new Error('电脑正在和另一台手机直连');
        await this.end('idle');
        const session = { id: crypto.randomUUID(), key: pair.key, deviceId: pair.deviceId, name: pair.name, status: 'connecting',
          expiresAt: now + RESUME_OFFER_MS, seen: new Set(), sequence: 0, resumeDeviceId: pair.deviceId, channel, framed };
        this.session = session;
        authenticated(session);
        await this.authenticate(session);
      };
      return;
    }
    handler = async (raw) => {
      const session = this.session;
      if (!session || session.id !== target || session.authenticated || !['waiting', 'connecting'].includes(session.status) || Date.now() > session.expiresAt) throw new Error('连接码已失效');
      const frame = JSON.parse(raw);
      if (frame.kind !== 'direct.hello' || typeof frame.id !== 'string' || frame.id.length > 100) throw new Error('直连配对认证失败');
      const payload = decryptJson(session.key, frame);
      if (payload.id !== session.id || !UUID.test(payload.deviceId || '')) throw new Error('直连配对认证失败');
      handler = async () => {};
      session.status = 'connecting';
      await this.connector.setDirectMode(true);
      if (this.session !== session) return;
      session.deviceId = payload.deviceId; session.name = String(payload.name || '手机').slice(0, 120);
      session.seen.add(frame.id);
      // The tunnel won: WebRTC for this QR is no longer needed.
      const peer = session.peer; session.peer = null; session.signaling?.close();
      session.channel = channel; session.framed = framed;
      peer?.close().catch(() => {});
      authenticated(session);
      await this.authenticate(session);
    };
  }
  async receive(session, raw) {
    if (this.session !== session || !session.deviceId) return;
    const frame = JSON.parse(raw);
    if (typeof frame.id !== 'string' || frame.id.length > 100 || !frame.kind || session.seen.has(frame.id)) return;
    if (session.seen.size >= 10000) { const oldest = session.seen.values().next().value; session.seen.delete(oldest); }
    const payload = decryptJson(session.key, frame); session.seen.add(frame.id);
    if (!session.authenticated) {
      if (Date.now() > session.expiresAt || frame.kind !== 'direct.hello' || payload.id !== session.id || payload.deviceId !== session.deviceId) throw new Error('直连配对认证失败');
      await this.authenticate(session);
      return;
    }
    session.lastReceived = Date.now();
    if (frame.kind === 'direct.ping') { this.send('direct.pong', null, { sentAt: payload.sentAt }); return; }
    if (frame.kind === 'direct.request') {
      let result;
      try {
        if (payload.path === '/api/v2/account') result = { profile: { displayName: `${this.connector.config.deviceName} · 直连` },
          entitlements: [], effectiveEntitlement: { source: 'direct', canWrite: true }, devices: [
            { id: this.connector.config.deviceId, name: this.connector.config.deviceName, type: 'connector', revokedAt: null },
            { id: session.deviceId, name: session.name, type: 'android', revokedAt: null }] };
        else if (payload.path.startsWith('/api/v2/events?')) result = { items: [] };
        else result = await this.connector.directHistory.get(payload.path, session.key);
        this.send('direct.response', null, { requestId: payload.requestId, ok: true, result });
      } catch (error) { this.send('direct.response', null, { requestId: payload.requestId, ok: false, error: error.message }); }
      return;
    }
    if (!['command', 'command.control', 'file.command', 'approval.resolve'].includes(frame.kind)) return;
    // Bind the sender to the QR-confirmed device; never trust an incoming source id.
    await this.connector.onFrame(JSON.stringify({ ...frame, sourceDeviceId: session.deviceId, sequence: undefined }), { direct: true, key: session.key });
  }
  send(kind, threadId, value, targetDeviceId = null) {
    const session = this.session;
    if (!this.connected || (targetDeviceId && targetDeviceId !== session.deviceId)) return false;
    const id = crypto.randomUUID();
    return session.framed.send(JSON.stringify({ id, kind, threadId: threadId || null, sourceDeviceId: this.connector.config.deviceId,
      targetDeviceId: session.deviceId, createdAt: Date.now(), sequence: ++session.sequence, ...encryptJson(session.key, kind, threadId, id, value),
      ...blobFields(session.key, id, value) }),
      { priority: ['connector.presence', 'direct.welcome', 'direct.pong', 'command.result'].includes(kind) });
  }
  fail(session, error) { if (this.session === session) this.end('failed', error.message).catch((e) => this.connector.log(e)); }
  async end(status, error, invalidate = true) {
    if (invalidate) this.generation++;
    const session = this.session; this.session = null;
    if (session) {
      session.authenticated = false; session.signaling?.close();
      if (session.channel?.transport === 'tunnel') session.channel.close();
      await session.peer?.close().catch(() => {});
    }
    if (status !== 'idle') this.session = { status, error, expiresAt: Infinity };
  }
  async close() {
    clearInterval(this.timer); await this.end('idle'); this.resume.stop();
    // A restart keeps the tunnel and its address for the paired phone.
    if (this.connector.config.directOnly && this.pairs.list().length && this.tunnel.detach) this.tunnel.detach(); else this.tunnel.stop();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    try { fs.unlinkSync(this.controlFile); } catch {}
  }
}
module.exports = { DirectHub };
