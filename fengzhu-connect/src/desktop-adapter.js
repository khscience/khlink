const path = require('node:path');
const { spawn } = require('node:child_process');
const { withRequestMarker } = require('./request-marker');
const { installDesktopAdapter } = require('./desktop-adapter-runtime');

class DesktopAdapter {
  constructor(config = {}) {
    // A versioned image can be staged before light reload even while Windows
    // keeps the previous persistent adapter executable open.
    this.bin = config.desktopAdapterBin || path.join(__dirname, '..', 'bin', 'fengzhu-desktop-adapter-v2.1-0.2.121-composer.exe');
    this.bundledBin = this.bin;
    this.installBundledRuntime = !config.desktopAdapterBin && process.platform === 'win32';
    // The adapter's stderr (what the menus it read showed, and trace lines)
    // goes to the connector's log through this hook, a bounded number of lines per minute.
    this.log = typeof config.log === 'function' ? config.log : null;
    this.logWindowStart = 0;
    this.logWindowCount = 0;
    // A one-shot process pays a full Windows process spawn plus a fresh
    // COM/UI Automation client init on every single probe or dispatch. That
    // per-call startup cost is the likely reason probes ran close enough to
    // their timeout to fail intermittently (surfaced as recurring "Desktop
    // adapter timed out" from the periodic queue scan). The adapter binary's
    // `--serve` mode keeps one process alive and answers many newline-framed
    // requests over its stdio pipes instead, so only the very first call
    // after connector startup pays the process-spawn cost.
    this.child = null;
    this.starting = null;
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map();
    this.callTail = Promise.resolve();
    this.queuedCalls = 0;
    this.spawn = config.desktopAdapterSpawn || spawn;
  }

  ensureChild() {
    if (this.child?.stdin?.writable) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      if (this.installBundledRuntime) this.bin = installDesktopAdapter(this.bundledBin);
      const child = this.spawn(this.bin, ['--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      child.stdout.setEncoding('utf8');
      // Each process has its own line buffer: output from one being killed
      // must not run into the next one's.
      const stream = { buffer: '' };
      child.stdout.on('data', (chunk) => this.onData(chunk, stream));
      // Trace output (FENGZHU_ADAPTER_TRACE) and the failure notes the adapter
      // writes (which menu items it saw) go to stderr; nothing the JSON framing
      // on stdout needs to see. Each process has its own line buffer.
      child.stderr.setEncoding('utf8');
      const errors = { buffer: '' };
      child.stderr.on('data', (chunk) => this.onStderr(chunk, errors));
      // A write racing the process's exit fails with EPIPE; without a handler
      // that error would end the whole connector. The exit handler below
      // settles every request still waiting.
      child.stdin.on('error', () => {});
      child.once('spawn', () => { settled = true; resolve(child); });
      child.once('error', (error) => {
        if (!settled) { settled = true; error.delivery = 'not_sent'; reject(error); }
      });
      child.once('exit', () => {
        if (this.child === child) this.child = null;
        // Every request still in flight belongs to a process that is now
        // gone. `uncertain` (not a hard failure) lets the connector's retry
        // sweep re-probe against the respawned process instead of treating
        // a crash mid-scan as a confirmed delivery failure.
        // Only this process's requests: a replacement may already be running.
        const error = new Error('Desktop adapter process exited'); error.delivery = 'uncertain';
        for (const [id, item] of this.pending) {
          if (item.child !== child) continue;
          clearTimeout(item.timer); item.reject(error); this.pending.delete(id);
        }
      });
      this.child = child;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  onData(chunk, stream = this) {
    stream.buffer += chunk;
    const lines = stream.buffer.split(/\r?\n/); stream.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let envelope; try { envelope = JSON.parse(line); } catch { continue; }
      const item = this.pending.get(envelope.id); if (!item) continue;
      if (envelope.phase === 'write') { item.writeStarted = true; continue; }
      this.pending.delete(envelope.id);
      clearTimeout(item.timer);
      const result = envelope.response;
      if (!result?.ok) {
        const error = new Error(result?.message || result?.code || 'Desktop adapter failed');
        error.code = result?.code; error.delivery = result?.delivery || 'not_sent';
        item.reject(error); continue;
      }
      item.resolve(result);
    }
  }

  onStderr(chunk, stream = this) {
    stream.errorBuffer = (stream.errorBuffer || '') + chunk;
    const lines = stream.errorBuffer.split(/\r?\n/); stream.errorBuffer = lines.pop() || '';
    for (const line of lines) this.logAdapterLine(line);
    // A line that never ends is cut here so the buffer cannot grow without bound.
    if (stream.errorBuffer.length > 4096) { this.logAdapterLine(stream.errorBuffer); stream.errorBuffer = ''; }
  }

  logAdapterLine(line) {
    const text = String(line || '').trim();
    if (!text || !this.log) return;
    // A menu with many items can print many lines; a minute's worth is kept.
    const now = Date.now();
    if (now - this.logWindowStart >= 60_000) { this.logWindowStart = now; this.logWindowCount = 0; }
    if (this.logWindowCount >= 40) return;
    this.logWindowCount += 1;
    this.log(`desktop adapter: ${text.slice(0, 300)}`);
  }

  // A request is in flight (the adapter process handles them one by one).
  get busy() { return this.queuedCalls > 0 || this.pending.size > 0; }

  call(request, timeoutMs = 12_000) {
    // --serve handles one request at a time. Start each timeout only when
    // that request gets its turn, otherwise a short presence/queue probe can
    // kill a perfectly healthy process still handling a longer UI operation.
    this.queuedCalls += 1;
    const result = this.callTail.then(() => this.callNow(request, timeoutMs));
    this.callTail = result.catch(() => {});
    return result.finally(() => { this.queuedCalls -= 1; });
  }

  async callNow(request, timeoutMs) {
    const child = await this.ensureChild();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const active = this.pending.get(id);
        this.pending.delete(id);
        const error = new Error('Desktop adapter timed out');
        error.delivery = request.action === 'steer_queued' && !active?.writeStarted ? 'not_sent' : 'uncertain';
        error.action = request.action;
        reject(error);
        // The process is still stuck on this request and answers one at a
        // time, so every later request would queue behind it and time out
        // too. Start a fresh one on the next call.
        if (this.child === child) this.child = null;
        try { child.kill(); } catch { /* already gone */ }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try {
        child.stdin.write(`${JSON.stringify({ id, request })}\n`);
      } catch (error) {
        this.pending.delete(id); clearTimeout(timer);
        error.delivery = 'not_sent'; reject(error);
      }
    });
  }

  probe(threadId = null, title = null) { return this.call({ action: 'probe', threadId, title }); }
  // Navigation does not submit a message. Keep this separate from dispatch so
  // a slow history restore cannot turn an unsent request into an uncertain write.
  openThread(item) { return this.call({ action: 'open_thread', threadId: item.threadId, title: item.title || null }, 30_000); }
  dispatch(item) {
    const request = {
      action: 'dispatch', requestId: item.requestId, threadId: item.threadId,
      title: item.title || null, mode: item.mode, text: item.text,
      // Keep the attachment payload when routing through the native Desktop
      // adapter.  The old implementation deliberately sent an empty list,
      // which made Desktop receive only the textual KH Link attachment hint;
      // the phone still showed a preview, but Codex had no image to inspect.
      // Paths are resolved and validated by Connector.resolveAttachments()
      // before a follow-up reaches this adapter.
      attachments: Array.isArray(item.attachments) ? item.attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        size: attachment.size || 0,
        mimeType: attachment.mimeType || null,
      })) : [],
    };
    return this.call(request, 12_000);
  }
  interrupt(item) { return this.call({ action: 'interrupt', threadId: item.threadId, title: item.title || null }, 20_000); }
  queuedText(item) {
    // Protocol queue/add includes the request marker. The native adapter
    // locates an exact text row; matching the unmarked phone preview failed.
    if (item.codexQueueText) return item.codexQueueText;
    return item.queueTransport === 'codex' && item.requestId
      ? withRequestMarker(item.displayText || item.text, item.requestId)
      : item.displayText || item.text;
  }
  cancel(item) { return this.call({ action: 'cancel', requestId: item.requestId, threadId: item.threadId, title: item.title || null, text: this.queuedText(item) }); }
  // Account for task selection and the native row's paint/search window. A
  // read-only UIA lookup may exceed 12 s on a busy computer; keep the existing
  // write-phase boundary so a lost invocation receipt remains uncertain.
  steer(item) { return this.call({ action: 'steer_queued', requestId: item.requestId, threadId: item.threadId, title: item.title || null, text: this.queuedText(item) }, 30_000); }
  listQueued(threads) {
    // This read-only scan also checks the selected task's approval prompt.
    // Give UI Automation enough time on a busy computer without spawning a
    // new helper on each poll.
    return this.call({ action: 'list_queued', knownTitles: threads.map((thread) => thread.title).filter(Boolean) }, 8_000);
  }
  // Reuses the persistent adapter process instead of starting PowerShell or a
  // fresh UI Automation client for every presence heartbeat. The adapter only
  // enumerates visible top-level windows and their executable paths.
  agentPresence() { return this.call({ action: 'agent_presence' }, 3_000); }
  settings(item) {
    return this.call({
      action: 'settings', threadId: item.threadId, title: item.title || null,
      model: item.model ?? null, effort: item.effort ?? null,
      serviceTier: item.serviceTier ?? null, permissionMode: item.permissionMode ?? null,
      collaborationMode: item.collaborationMode ?? null,
    }, 30_000);
  }
}

module.exports = { DesktopAdapter };
