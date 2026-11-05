const { updateSecrets, relayEnabled } = require('./config');

const TOKEN_MARGIN_MS = 3 * 60_000;
const REFRESH_RETRY_LOGIN_MS = 60_000;
const REFRESH_RETRY_MS = 10_000;
// Idempotent requests (history uploads are upserts by id) ride out a flaky or
// throttled link instead of failing a whole sync pass.
const RETRY_DELAYS_MS = [1_500, 4_000, 10_000];
// A request stuck on a half-dead network (seen: a token refresh that took
// 40 minutes to fail) held up every reconnect behind it.
const REQUEST_TIMEOUT_MS = 45_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const UPLOAD_ISSUE_AFTER_MS = 60_000;
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/;

// Why a relay request did not get through, or null for an answer that did
// arrive (a 4xx is the request's own problem, not the line's).
function serverFailureReason(error) {
  const code = String(error?.cause?.code || error?.code || '');
  const name = String(error?.name || error?.cause?.name || '');
  if (CERT_CODES.test(code)) return 'certificate';
  if (/Timeout|Abort/.test(name) || /TIMEOUT/.test(code)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/^5\d\d /.test(String(error?.message || ''))) return 'server';
  // fetch reports a line failure as TypeError('fetch failed'); other
  // TypeErrors are bugs in the request, not the network.
  if ((error instanceof TypeError && error.message === 'fetch failed') || /ECONN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR/.test(code)) return 'network';
  return null;
}
const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BridgeApi {
  constructor(config) { this.config = config; this.accessToken = null; this.expiresAt = 0; this.serverAbort = new AbortController(); }

  get version() { return this.config.protocolVersion === 2 ? 'v2' : 'v1'; }
  path(suffix) { return `/api/${this.version}${suffix}`; }
  webSocketPath() { return this.version === 'v2' ? '/bridge/v2/ws' : '/bridge/ws'; }

  async setup(password) {
    const challenge = await this.request('/api/v1/auth/challenge', { method: 'POST', auth: false });
    const { deriveAccountKey, loginProof, wrapAccountKey } = require('./crypto');
    const passwordKey = deriveAccountKey(password, challenge.salt, challenge.iterations);
    const key = this.config.accountKey ? Buffer.from(this.config.accountKey, 'base64') : require('node:crypto').randomBytes(32);
    const keyEnvelope = wrapAccountKey(passwordKey, key);
    const result = await this.request('/api/v1/auth/login', { method: 'POST', auth: false, body: {
      challengeId: challenge.challengeId, proof: loginProof(passwordKey, challenge.challengeId, challenge.nonce), keyEnvelope,
      deviceId: this.config.deviceId, deviceName: this.config.deviceName, deviceType: 'connector',
    }});
    this.accessToken = result.accessToken; this.expiresAt = result.expiresAt;
    this.config = updateSecrets(this.config, { accountKey: key.toString('base64'), refreshToken: result.refreshToken });
    return this.config;
  }

  // Refreshed well before expiry: on a throttled link a large upload can take
  // minutes to reach the server, which checks the token only on arrival.
  async token() {
    if (this.accessToken && this.expiresAt > Date.now() + TOKEN_MARGIN_MS) return this.accessToken;
    // After a failed refresh every sync loop asked again at once: about 120
    // refreshes a minute, which tripped the relay's rate limit for the whole
    // IP, the desktop's sign-in included. Callers now get the same failure
    // until a pause has passed or a new sign-in brings another refresh token.
    const blocked = this.refreshFailure;
    if (blocked && blocked.token === this.config.refreshToken && blocked.until > Date.now()) throw blocked.error;
    // Concurrent callers share one refresh instead of racing each other.
    if (!this.refreshing) {
      this.refreshing = this.refreshToken().then((token) => { this.refreshFailure = null; return token; }, (error) => {
        // A dead login waits for a new sign-in; a busy or unreachable server
        // gets a short pause.
        const login = /^(401|403)\b/.test(String(error?.message || '')) || /login required/i.test(String(error?.message || ''));
        this.refreshFailure = { error, token: this.config.refreshToken, until: Date.now() + (login ? REFRESH_RETRY_LOGIN_MS : REFRESH_RETRY_MS) };
        throw error;
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async refreshToken() {
    if (!this.config.refreshToken) throw new Error('Connector login required');
    const path = this.version === 'v2' ? this.path('/session/refresh') : this.path('/auth/refresh');
    const body = { deviceId: this.config.deviceId, refreshToken: this.config.refreshToken };
    if (this.version === 'v2') body.accountId = this.config.accountId;
    const result = await this.request(path, { method: 'POST', auth: false, body });
    this.accessToken = result.accessToken; this.expiresAt = result.expiresAt;
    this.config = updateSecrets(this.config, { refreshToken: result.refreshToken });
    return this.accessToken;
  }

  // Requests to the relay that cannot get through (2026-11-05: a self-signed
  // certificate on the home line for ~1 h) were only logged; the phone still
  // saw the computer as connected over its open socket. Track the failure so
  // the presence can tell the phone why new content is not arriving.
  async request(path, options = {}, retried = false) {
    try {
      const result = await this.sendRequest(path, options, retried);
      this.serverFailure = null;
      return result;
    } catch (error) {
      // Our own abort (stopping, switching to direct mode) is not the line.
      const reason = this.serverAbort.signal.aborted ? null : serverFailureReason(error);
      if (reason) {
        const now = Date.now();
        this.serverFailure = { reason, since: this.serverFailure?.since || now, at: now };
      }
      throw error;
    }
  }

  /** {reason, since} once relay requests have failed for a minute, else null. */
  uploadIssue(now = Date.now()) {
    const failure = this.serverFailure;
    if (!failure || now - failure.since < UPLOAD_ISSUE_AFTER_MS) return null;
    return { reason: failure.reason, since: failure.since };
  }

  async sendRequest(path, options = {}, retried = false) {
    if (options.method === 'PUT' && path.includes('/history/') && this.localHistory && !options.skipLocal) {
      // On standby (direct mode, relay kept as the fallback) history stays local
      // until a phone uses the relay; the connector then catches the relay up.
      const localOnly = !relayEnabled(this.config) || Boolean(this.relayStandby?.());
      let saved;
      try { saved = await this.localHistory.put(path, options.body); }
      catch (error) { if (localOnly) throw error; }
      if (localOnly && saved) return saved;
    }
    if (!relayEnabled(this.config)) throw new Error('当前为二维码直连模式，已关闭业务服务器请求');
    const method = options.method || 'GET';
    const delays = IDEMPOTENT.has(method) ? (this.retryDelays || RETRY_DELAYS_MS) : [];
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    let response;
    for (let attempt = 0; ; attempt++) {
      if (!relayEnabled(this.config)) throw new Error('当前为二维码直连模式，已关闭业务服务器请求');
      const headers = { 'content-type': 'application/json' };
      if (options.auth !== false) headers.authorization = `Bearer ${await this.token()}`;
      try {
        response = await fetch(`${this.config.serverUrl}${path}`, { method, headers, body,
          signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS), this.serverAbort.signal]) });
      } catch (error) {
        if (attempt >= delays.length) throw error;
        await sleep(delays[attempt]); continue;
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= delays.length) break;
      await response.text().catch(() => '');
      await sleep(delays[attempt]);
    }
    if (!response.ok) {
      const text = await response.text();
      // The token ran out while the request was on its way: renew and resend once.
      if (response.status === 401 && options.auth !== false && !retried && /Token expired/i.test(text)) {
        this.accessToken = null; this.expiresAt = 0;
        return this.sendRequest(path, options, true);
      }
      // An error page (e.g. a proxy's 503 HTML) is not worth carrying whole.
      const brief = text.length > 300 ? `${text.replace(/\s+/g, ' ').slice(0, 300)}…` : text;
      throw new Error(`${response.status} ${brief}`);
    }
    return response.json();
  }
}

module.exports = { BridgeApi, serverFailureReason };
