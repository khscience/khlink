import { ConflictException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AccountDevice, AccountProfile, AuthDevice, DeviceType, EncryptedFrame, KhQuantProfile, StoredEntitlement } from './types'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database

  onModuleInit(): void {
    const path = process.env.SQLITE_PATH || join(process.cwd(), 'data', 'fengzhu-bridge.db')
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  onModuleDestroy(): void {
    this.db?.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_auth (
        id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL,
        verifier TEXT NOT NULL, iterations INTEGER NOT NULL, key_nonce TEXT,
        key_ciphertext TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        public_key TEXT, refresh_hash TEXT, refresh_expires_at INTEGER,
        revoked_at INTEGER, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        source_device_id TEXT NOT NULL, target_device_id TEXT, kind TEXT NOT NULL,
        thread_id TEXT, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_target_sequence ON events(target_device_id, sequence);
      CREATE TABLE IF NOT EXISTS history_threads (
        id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_threads_updated ON history_threads(updated_at DESC);
      CREATE TABLE IF NOT EXISTS history_items (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, item_order INTEGER NOT NULL,
        nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES history_threads(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_history_item_order ON history_items(thread_id, item_order);

      -- KH Link v2 is account-scoped. These tables are deliberately separate from
      -- the legacy single-admin data so a production cutover starts from a clean account model.
      CREATE TABLE IF NOT EXISTS accounts_v2 (
        id TEXT PRIMARY KEY, khquant_subject TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        avatar_url TEXT, membership_state TEXT NOT NULL, membership_plan TEXT,
        membership_expires_at INTEGER, disabled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_devices_v2 (
        account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        public_key TEXT, refresh_hash TEXT, refresh_expires_at INTEGER, revoked_at INTEGER,
        last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, id), FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_account_devices_v2_global_id ON account_devices_v2(id);
      CREATE INDEX IF NOT EXISTS idx_account_devices_v2_active_desktop
        ON account_devices_v2(account_id) WHERE type='desktop' AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS pairing_sessions_v2 (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, desktop_device_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL, status TEXT NOT NULL, android_device_id TEXT,
        android_device_name TEXT, android_public_key TEXT, key_envelope TEXT,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER, consumed_at INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_sessions_v2_account ON pairing_sessions_v2(account_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS account_entitlements_v2 (
        account_id TEXT NOT NULL, product TEXT NOT NULL CHECK(product IN ('khquant', 'kh_link')),
        state TEXT NOT NULL, plan TEXT, expires_at INTEGER, provider_subscription_id TEXT,
        provider_event_id TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, product), FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_account_entitlements_v2_expiry ON account_entitlements_v2(product, expires_at);
      CREATE TABLE IF NOT EXISTS account_traffic_v2 (
        account_id TEXT NOT NULL, month TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, month)
      );
      CREATE TABLE IF NOT EXISTS account_events_v2 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, id TEXT NOT NULL,
        source_device_id TEXT NOT NULL, target_device_id TEXT, kind TEXT NOT NULL, thread_id TEXT,
        nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(account_id, id), FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_account_events_v2_target ON account_events_v2(account_id, target_device_id, sequence);
      CREATE TABLE IF NOT EXISTS account_history_threads_v2 (
        account_id TEXT NOT NULL, id TEXT NOT NULL, connector_id TEXT NOT NULL, nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, id), FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS account_history_items_v2 (
        account_id TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, item_order INTEGER NOT NULL,
        nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, thread_id, id), UNIQUE(account_id, thread_id, item_order),
        FOREIGN KEY(account_id, thread_id) REFERENCES account_history_threads_v2(account_id, id) ON DELETE CASCADE
      );
      -- Conversations deleted on the relay (prune-history). Connectors still
      -- have them and would upload them again; uploads no newer than the
      -- deletion are dropped, and phones remove them from their copy.
      CREATE TABLE IF NOT EXISTS account_history_deleted_v2 (
        account_id TEXT NOT NULL, thread_id TEXT NOT NULL, deleted_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, thread_id), FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE
      );
      -- Conversations whose older items were removed (prune-history): items
      -- below trimmed_before are gone, and uploads of them are dropped.
      CREATE TABLE IF NOT EXISTS account_history_trimmed_v2 (
        account_id TEXT NOT NULL, thread_id TEXT NOT NULL, trimmed_before INTEGER NOT NULL, trimmed_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, thread_id),
        FOREIGN KEY(account_id, thread_id) REFERENCES account_history_threads_v2(account_id, id) ON DELETE CASCADE
      );
    `)
    const authColumns = (this.db.prepare('PRAGMA table_info(admin_auth)').all() as Array<{ name: string }>).map((column) => column.name)
    if (!authColumns.includes('key_nonce')) this.db.exec('ALTER TABLE admin_auth ADD COLUMN key_nonce TEXT')
    if (!authColumns.includes('key_ciphertext')) this.db.exec('ALTER TABLE admin_auth ADD COLUMN key_ciphertext TEXT')
    const deviceColumns = (this.db.prepare('PRAGMA table_info(account_devices_v2)').all() as Array<{ name: string }>).map((column) => column.name)
    if (!deviceColumns.includes('key_envelope')) this.db.exec('ALTER TABLE account_devices_v2 ADD COLUMN key_envelope TEXT')
    if (!deviceColumns.includes('client_version')) this.db.exec('ALTER TABLE account_devices_v2 ADD COLUMN client_version TEXT')
    // When the relay last stored each conversation row, stamped here (the
    // connector's updated_at can stay put while the row changes), so phones
    // fetch only rows changed since their last look.
    const threadColumns = (this.db.prepare('PRAGMA table_info(account_history_threads_v2)').all() as Array<{ name: string }>).map((column) => column.name)
    if (!threadColumns.includes('changed_at')) {
      this.db.exec('ALTER TABLE account_history_threads_v2 ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0')
      this.db.exec('UPDATE account_history_threads_v2 SET changed_at=updated_at')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_account_history_threads_v2_changed ON account_history_threads_v2(account_id, changed_at)')
    // The last stamp given out per account. MAX(changed_at) would go back when
    // the newest row is deleted, and the next row could reuse a stamp a phone
    // has already passed.
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_history_changed_v2 (
      account_id TEXT PRIMARY KEY, changed_at INTEGER NOT NULL, FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE)`)
    // The same for conversation items: an open conversation on a phone asks
    // only for the items stored since its last look, instead of the newest
    // page again on every update (most of a phone's history traffic).
    const itemColumns = (this.db.prepare('PRAGMA table_info(account_history_items_v2)').all() as Array<{ name: string }>).map((column) => column.name)
    if (!itemColumns.includes('changed_at')) this.db.exec('ALTER TABLE account_history_items_v2 ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_account_history_items_v2_changed ON account_history_items_v2(account_id, thread_id, changed_at)')
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_history_items_changed_v2 (
      account_id TEXT PRIMARY KEY, changed_at INTEGER NOT NULL, FOREIGN KEY(account_id) REFERENCES accounts_v2(id) ON DELETE CASCADE)`)
    // Older deployments created this as a unique partial index, which made
    // the account schema accidentally single-computer. Replace it with a
    // normal lookup index so each installation can own its own connector.
    this.db.exec('DROP INDEX IF EXISTS idx_account_devices_v2_active_desktop')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_account_devices_v2_active_desktop ON account_devices_v2(account_id) WHERE type=\'desktop\' AND revoked_at IS NULL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_nonces_v2 (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_bans_v2 (account_id TEXT PRIMARY KEY, reason TEXT NOT NULL, actor_subject TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_operations_v2 (event_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_entitlements_v2 (subject TEXT PRIMARY KEY, entitlement_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events_v2 (event_id TEXT PRIMARY KEY, subject TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS download_events_v2 (request_id TEXT PRIMARY KEY, version TEXT NOT NULL, platform TEXT NOT NULL, source TEXT NOT NULL, ip_address TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_download_events_v2_time ON download_events_v2(created_at);
      CREATE TABLE IF NOT EXISTS download_daily_v2 (day TEXT NOT NULL, version TEXT NOT NULL, platform TEXT NOT NULL, source TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,version,platform,source));
      CREATE TABLE IF NOT EXISTS download_cursors_v2 (log_path TEXT PRIMARY KEY, cursor_json TEXT NOT NULL);
    `)
  }

  getAuth(): { salt: string; verifier: string; iterations: number; keyNonce: string | null; keyCiphertext: string | null } | undefined {
    return this.db.prepare('SELECT salt, verifier, iterations, key_nonce AS keyNonce, key_ciphertext AS keyCiphertext FROM admin_auth WHERE id=1').get() as
      | { salt: string; verifier: string; iterations: number; keyNonce: string | null; keyCiphertext: string | null }
      | undefined
  }

  createAuth(salt: string, verifier: string, iterations: number): void {
    this.db.prepare('INSERT INTO admin_auth(id,salt,verifier,iterations,created_at) VALUES(1,?,?,?,?)')
      .run(salt, verifier, iterations, Date.now())
  }

  setKeyEnvelope(nonce: string, ciphertext: string): void {
    this.db.prepare('UPDATE admin_auth SET key_nonce=?,key_ciphertext=? WHERE id=1').run(nonce, ciphertext)
  }

  changeAuth(salt: string, verifier: string, iterations: number, nonce: string, ciphertext: string): void {
    this.db.prepare('UPDATE admin_auth SET salt=?,verifier=?,iterations=?,key_nonce=?,key_ciphertext=? WHERE id=1')
      .run(salt, verifier, iterations, nonce, ciphertext)
  }

  upsertAccount(input: KhQuantProfile): string {
    const now = Date.now()
    const existing = this.db.prepare('SELECT id FROM accounts_v2 WHERE khquant_subject=?').get(input.subject) as { id: string } | undefined
    const id = existing?.id || randomUUID()
    this.db.prepare(`INSERT INTO accounts_v2
      (id,khquant_subject,display_name,avatar_url,membership_state,membership_plan,membership_expires_at,disabled_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(khquant_subject) DO UPDATE SET
      display_name=excluded.display_name,avatar_url=excluded.avatar_url,disabled_at=excluded.disabled_at,updated_at=excluded.updated_at`)
      .run(id, input.subject, input.displayName, input.avatarUrl || null, 'unavailable', null, null, input.disabled ? now : null, now, now)
    const pending = this.db.prepare('SELECT entitlement_json FROM pending_entitlements_v2 WHERE subject=?').get(input.subject) as { entitlement_json: string } | undefined
    if (pending) this.upsertEntitlement({ ...JSON.parse(pending.entitlement_json), accountId: id, product: 'kh_link' })
    return id
  }

  claimAdminNonce(nonce: string, timestamp: number): boolean {
    this.db.prepare('DELETE FROM admin_nonces_v2 WHERE expires_at<?').run(Date.now())
    return this.db.prepare('INSERT OR IGNORE INTO admin_nonces_v2(nonce,expires_at) VALUES(?,?)').run(nonce, timestamp + 310_000).changes === 1
  }

  isAccountBanned(accountId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM account_bans_v2 WHERE account_id=?').get(accountId)
  }

  accountBySubject(subject: string): (AccountProfile & { banned: boolean; createdAt: number; updatedAt: number }) | undefined {
    return this.db.prepare(`SELECT id,khquant_subject AS khQuantSubject,display_name AS displayName,disabled_at AS disabledAt,
      EXISTS(SELECT 1 FROM account_bans_v2 b WHERE b.account_id=a.id) AS banned,created_at AS createdAt,updated_at AS updatedAt
      FROM accounts_v2 a WHERE khquant_subject=?`).get(subject) as never
  }

  adminAccounts(query = '', offset = 0, limit = 30): { accounts: Array<AccountProfile & { banned: boolean }>; total: number; activeToday: number; limit: number; offset: number } {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 30)))
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
    const pattern = `%${String(query).slice(0, 100)}%`
    const accounts = this.db.prepare(`SELECT id,khquant_subject AS khQuantSubject,display_name AS displayName,disabled_at AS disabledAt,
      EXISTS(SELECT 1 FROM account_bans_v2 b WHERE b.account_id=a.id) AS banned,created_at AS createdAt,updated_at AS updatedAt
      FROM accounts_v2 a WHERE khquant_subject LIKE ? OR display_name LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(pattern, pattern, safeLimit, safeOffset) as Array<AccountProfile & { banned: boolean }>
    const total = (this.db.prepare('SELECT COUNT(*) n FROM accounts_v2 WHERE khquant_subject LIKE ? OR display_name LIKE ?').get(pattern, pattern) as { n: number }).n
    const dayStart = Math.floor((Date.now() + 8 * 3600_000) / 86_400_000) * 86_400_000 - 8 * 3600_000
    const activeToday = (this.db.prepare('SELECT COUNT(*) n FROM account_devices_v2 WHERE revoked_at IS NULL AND last_seen_at>?').get(dayStart) as { n: number }).n
    return { accounts, total, activeToday, limit: safeLimit, offset: safeOffset }
  }

  // Deliberately projected metadata only: never selects public keys, envelopes,
  // refresh credentials, account_events or account_history tables.
  adminDevices(accountId: string): Array<{ id: string; accountId: string; name: string; type: string; revokedAt: number | null; lastSeenAt: number; createdAt: number; version: string | null }> {
    return this.db.prepare(`SELECT id,account_id AS accountId,name,type,revoked_at AS revokedAt,last_seen_at AS lastSeenAt,created_at AS createdAt,client_version AS version
      FROM account_devices_v2 WHERE account_id=? ORDER BY created_at DESC`).all(accountId) as never
  }

  adminAllDevices(query = '', offset = 0, limit = 30): { devices: Array<{ id: string; accountId: string; subject: string }>; total: number; limit: number; offset: number; versions: unknown[] } {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 30)))
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0)); const pattern = `%${String(query).slice(0, 100)}%`
    const clause = 'WHERE a.khquant_subject LIKE ? OR d.name LIKE ? OR d.type LIKE ? OR d.client_version LIKE ?'
    const parameters = [pattern, pattern, pattern, pattern]
    const devices = this.db.prepare(`SELECT d.id,d.account_id AS accountId,a.khquant_subject AS subject,d.name,d.type,d.client_version AS version,
      d.revoked_at AS revokedAt,d.last_seen_at AS lastSeenAt,d.created_at AS createdAt FROM account_devices_v2 d JOIN accounts_v2 a ON a.id=d.account_id ${clause} ORDER BY d.last_seen_at DESC LIMIT ? OFFSET ?`).all(...parameters, safeLimit, safeOffset) as never
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM account_devices_v2 d JOIN accounts_v2 a ON a.id=d.account_id ${clause}`).get(...parameters) as { n: number }).n
    const versions = this.db.prepare('SELECT type,client_version AS version,COUNT(*) count FROM account_devices_v2 WHERE revoked_at IS NULL GROUP BY type,client_version').all()
    return { devices, total, limit: safeLimit, offset: safeOffset, versions }
  }

  updateDeviceVersion(accountId: string, deviceId: string, version: string | undefined): void {
    if (version && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) && version.length < 60) this.db.prepare('UPDATE account_devices_v2 SET client_version=? WHERE account_id=? AND id=?').run(version, accountId, deviceId)
  }

  touchAccountDevice(accountId: string, deviceId: string): void {
    this.db.prepare('UPDATE account_devices_v2 SET last_seen_at=? WHERE account_id=? AND id=? AND revoked_at IS NULL').run(Date.now(), accountId, deviceId)
  }

  adminResult(eventId: string): Record<string, any> | undefined {
    const row = this.db.prepare('SELECT result_json FROM admin_operations_v2 WHERE event_id=?').get(eventId) as { result_json: string } | undefined
    return row ? JSON.parse(row.result_json) : undefined
  }

  applyAdminAction(body: { subject: string; operation: string; deviceId?: string; actorSubject: string; reason: string; eventId: string; policy?: object }, accountId?: string): object {
    return this.db.transaction(() => {
      const before = accountId ? { banned: this.isAccountBanned(accountId), devices: this.adminDevices(accountId) } : null
      if (body.operation === 'ban') this.db.prepare('INSERT OR REPLACE INTO account_bans_v2(account_id,reason,actor_subject,updated_at) VALUES(?,?,?,?)').run(accountId!, body.reason, body.actorSubject, Date.now())
      if (body.operation === 'unban') this.db.prepare('DELETE FROM account_bans_v2 WHERE account_id=?').run(accountId!)
      if (body.operation === 'revoke-device') this.revokeAccountDevice(accountId!, body.deviceId!)
      if (body.operation === 'revoke-all') this.db.prepare('UPDATE account_devices_v2 SET revoked_at=?,refresh_hash=NULL,refresh_expires_at=NULL WHERE account_id=? AND revoked_at IS NULL').run(Date.now(), accountId!)
      const result = { accepted: true, subject: body.subject, operation: body.operation, actorSubject: body.actorSubject, deviceId: body.deviceId || null, reason: body.reason,
        before, after: accountId ? { banned: this.isAccountBanned(accountId), devices: this.adminDevices(accountId) } : null, policy: body.policy || null, at: Date.now() }
      this.db.prepare('INSERT INTO admin_operations_v2(event_id,result_json,created_at) VALUES(?,?,?)').run(body.eventId, JSON.stringify(result), Date.now())
      return result
    })()
  }

  applySubjectEntitlement(subject: string, input: Omit<StoredEntitlement, 'accountId' | 'product'>, payloadHash: string): { accepted: boolean; changed: boolean; pending: boolean } {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT subject,payload_hash FROM billing_events_v2 WHERE event_id=?').get(input.providerEventId!) as { subject: string; payload_hash: string } | undefined
      if (previous) {
        if (previous.subject !== subject || previous.payload_hash !== payloadHash) throw new Error('Billing event identity conflict')
        return { accepted: true, changed: false, pending: !this.accountBySubject(subject) }
      }
      const account = this.accountBySubject(subject)
      const pending = this.db.prepare('INSERT INTO pending_entitlements_v2(subject,entitlement_json,updated_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET entitlement_json=excluded.entitlement_json,updated_at=excluded.updated_at WHERE excluded.updated_at>pending_entitlements_v2.updated_at')
        .run(subject, JSON.stringify(input), input.updatedAt)
      const changed = account ? this.upsertEntitlement({ ...input, accountId: account.id, product: 'kh_link' }) : pending.changes > 0
      this.db.prepare('INSERT INTO billing_events_v2(event_id,subject,payload_hash,created_at) VALUES(?,?,?,?)').run(input.providerEventId!, subject, payloadHash, Date.now())
      return { accepted: true, changed, pending: !account }
    })()
  }

  recordAdminDownload(input: { requestId: string; version: string; platform: string; source: string; ip: string; at: number }): void {
    this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO download_events_v2(request_id,version,platform,source,ip_address,created_at) VALUES(?,?,?,?,?,?)')
        .run(input.requestId, input.version, input.platform, input.source, input.ip, input.at)
      if (inserted.changes) this.db.prepare('INSERT INTO download_daily_v2(day,version,platform,source,count) VALUES(?,?,?,?,1) ON CONFLICT(day,version,platform,source) DO UPDATE SET count=count+1')
        .run(new Date(input.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), input.version, input.platform, input.source)
      this.db.prepare('DELETE FROM download_events_v2 WHERE created_at<?').run(Date.now() - 90 * 86_400_000)
    })()
  }

  adminDownloadStats(offset = 0, limit = 30): object {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 30)))
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
    const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    return { summary: this.db.prepare('SELECT COALESCE(SUM(count),0) total,COALESCE(SUM(CASE WHEN day>=? THEN count ELSE 0 END),0) last30Days FROM download_daily_v2').get(start),
      daily: this.db.prepare('SELECT day,SUM(count) count FROM download_daily_v2 WHERE day>=? GROUP BY day ORDER BY day').all(start),
      versions: this.db.prepare('SELECT version,platform,SUM(count) count FROM download_daily_v2 GROUP BY version,platform').all(),
      sources: this.db.prepare('SELECT source,SUM(count) count FROM download_daily_v2 GROUP BY source').all(),
      events: this.db.prepare('SELECT request_id AS requestId,version,platform,source,ip_address AS ip,created_at AS at FROM download_events_v2 ORDER BY created_at DESC LIMIT ? OFFSET ?').all(safeLimit, safeOffset),
      total: (this.db.prepare('SELECT COUNT(*) n FROM download_events_v2').get() as { n: number }).n, offset: safeOffset, limit: safeLimit,
      collectionStartedAt: (this.db.prepare('SELECT MIN(created_at) at FROM download_events_v2').get() as { at: number | null }).at }
  }

  pruneDownloadDetails(): void {
    this.db.prepare('DELETE FROM download_events_v2 WHERE created_at<?').run(Date.now() - 90 * 86_400_000)
  }

  downloadCursor(file: string): { inode: number; position: number; pending: string } | null {
    const row = this.db.prepare('SELECT cursor_json FROM download_cursors_v2 WHERE log_path=?').get(file) as { cursor_json: string } | undefined
    return row ? JSON.parse(row.cursor_json) : null
  }

  saveDownloadCursor(file: string, cursor: { inode: number; position: number; pending: string }): void {
    this.db.prepare('INSERT INTO download_cursors_v2(log_path,cursor_json) VALUES(?,?) ON CONFLICT(log_path) DO UPDATE SET cursor_json=excluded.cursor_json').run(file, JSON.stringify(cursor))
  }

  getAccount(accountId: string): AccountProfile | undefined {
    return this.db.prepare(`SELECT id,khquant_subject AS khQuantSubject,display_name AS displayName,
      avatar_url AS avatarUrl,disabled_at AS disabledAt FROM accounts_v2 WHERE id=?`).get(accountId) as AccountProfile | undefined
  }

  upsertAccountDevice(input: { accountId: string; id: string; name: string; type: DeviceType; publicKey?: string; keyEnvelope?: string }): void {
    const now = Date.now()
    const owner = this.findAccountDevice(input.id)
    if (owner && owner.accountId !== input.accountId) throw new Error('Device identity is already bound to another account')
    this.db.prepare(`INSERT INTO account_devices_v2
      (account_id,id,name,type,public_key,key_envelope,last_seen_at,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET
      name=excluded.name,type=excluded.type,public_key=COALESCE(excluded.public_key,account_devices_v2.public_key),
      key_envelope=CASE
        WHEN excluded.key_envelope IS NOT NULL THEN excluded.key_envelope
        WHEN excluded.type='android' AND excluded.public_key IS NOT NULL
          AND excluded.public_key IS NOT account_devices_v2.public_key THEN NULL
        ELSE account_devices_v2.key_envelope END,
      last_seen_at=excluded.last_seen_at,revoked_at=NULL`)
      .run(input.accountId, input.id, input.name, input.type, input.publicKey || null, input.keyEnvelope || null, now, now)
  }

  getAccountDevice(accountId: string, deviceId: string): (AccountDevice & { refreshHash?: string; refreshExpiresAt?: number }) | undefined {
    return this.db.prepare(`SELECT account_id AS accountId,id,name,type,public_key AS publicKey,key_envelope AS keyEnvelope,
      revoked_at AS revokedAt,last_seen_at AS lastSeenAt,created_at AS createdAt,
      refresh_hash AS refreshHash,refresh_expires_at AS refreshExpiresAt
      FROM account_devices_v2 WHERE account_id=? AND id=?`).get(accountId, deviceId) as never
  }

  findAccountDevice(deviceId: string): (AccountDevice & { refreshHash?: string; refreshExpiresAt?: number }) | undefined {
    return this.db.prepare(`SELECT account_id AS accountId,id,name,type,public_key AS publicKey,key_envelope AS keyEnvelope,
      revoked_at AS revokedAt,last_seen_at AS lastSeenAt,created_at AS createdAt,
      refresh_hash AS refreshHash,refresh_expires_at AS refreshExpiresAt
      FROM account_devices_v2 WHERE id=?`).get(deviceId) as never
  }

  listAccountDevices(accountId: string, includeRevoked = false): AccountDevice[] {
    return this.db.prepare(`SELECT account_id AS accountId,id,name,type,public_key AS publicKey,key_envelope AS keyEnvelope,
      revoked_at AS revokedAt,last_seen_at AS lastSeenAt,created_at AS createdAt
      FROM account_devices_v2 WHERE account_id=? AND (?=1 OR revoked_at IS NULL) ORDER BY created_at`)
      .all(accountId, includeRevoked ? 1 : 0) as AccountDevice[]
  }

  setAccountRefresh(accountId: string, deviceId: string, hash: string, expiresAt: number): void {
    this.db.prepare(`UPDATE account_devices_v2 SET refresh_hash=?,refresh_expires_at=?,last_seen_at=?
      WHERE account_id=? AND id=?`).run(hash, expiresAt, Date.now(), accountId, deviceId)
  }

  extendAccountRefresh(accountId: string, deviceId: string, expiresAt: number): void {
    this.db.prepare(`UPDATE account_devices_v2 SET refresh_expires_at=?,last_seen_at=?
      WHERE account_id=? AND id=? AND revoked_at IS NULL AND refresh_hash IS NOT NULL`).run(expiresAt, Date.now(), accountId, deviceId)
  }

  revokeAccountDevice(accountId: string, deviceId: string): void {
    this.db.prepare(`UPDATE account_devices_v2 SET revoked_at=?,refresh_hash=NULL,refresh_expires_at=NULL
      WHERE account_id=? AND id=?`).run(Date.now(), accountId, deviceId)
  }

  createPairing(input: { id: string; accountId: string; desktopDeviceId: string; secretHash: string; expiresAt: number }): void {
    this.db.prepare(`INSERT INTO pairing_sessions_v2
      (id,account_id,desktop_device_id,secret_hash,status,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(input.id, input.accountId, input.desktopDeviceId, input.secretHash, 'created', input.expiresAt, Date.now())
  }

  getPairing(id: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT id,account_id AS accountId,desktop_device_id AS desktopDeviceId,
      secret_hash AS secretHash,status,android_device_id AS androidDeviceId,android_device_name AS androidDeviceName,
      android_public_key AS androidPublicKey,key_envelope AS keyEnvelope,expires_at AS expiresAt,
      created_at AS createdAt,confirmed_at AS confirmedAt,consumed_at AS consumedAt
      FROM pairing_sessions_v2 WHERE id=?`).get(id) as Record<string, unknown> | undefined
  }

  claimPairing(input: { id: string; deviceId: string; deviceName: string; publicKey: string }): boolean {
    const result = this.db.prepare(`UPDATE pairing_sessions_v2 SET status='pending',android_device_id=?,
      android_device_name=?,android_public_key=? WHERE id=? AND status='created' AND expires_at>?`)
      .run(input.deviceId, input.deviceName, input.publicKey, input.id, Date.now())
    return result.changes === 1
  }

  confirmPairing(id: string, accountId: string, keyEnvelope: string): boolean {
    const result = this.db.prepare(`UPDATE pairing_sessions_v2 SET status='confirmed',key_envelope=?,confirmed_at=?
      WHERE id=? AND account_id=? AND status='pending' AND expires_at>?`)
      .run(keyEnvelope, Date.now(), id, accountId, Date.now())
    return result.changes === 1
  }

  consumePairing(id: string): boolean {
    return this.db.prepare(`UPDATE pairing_sessions_v2 SET status='consumed',consumed_at=?
      WHERE id=? AND status='confirmed'`).run(Date.now(), id).changes === 1
  }

  expirePairing(id: string): void {
    this.db.prepare(`UPDATE pairing_sessions_v2 SET status='expired'
      WHERE id=? AND status IN ('created','pending','confirmed') AND expires_at<=?`).run(id, Date.now())
  }

  cleanupExpiredPairings(before = Date.now() - 24 * 60 * 60_000): number {
    this.db.prepare(`UPDATE pairing_sessions_v2 SET status='expired'
      WHERE status IN ('created','pending','confirmed') AND expires_at<=?`).run(Date.now())
    return this.db.prepare(`DELETE FROM pairing_sessions_v2
      WHERE status IN ('expired','consumed') AND COALESCE(consumed_at,expires_at,created_at)<?`).run(before).changes
  }

  completePairing(id: string): Record<string, unknown> | undefined {
    return this.db.transaction(() => {
      const pairing = this.getPairing(id)
      if (!pairing || pairing.status !== 'confirmed' || Number(pairing.expiresAt) <= Date.now()) return undefined
      if (!this.consumePairing(id)) return undefined
      const accountId = String(pairing.accountId)
      const deviceId = String(pairing.androidDeviceId)
      const owner = this.findAccountDevice(deviceId)
      if (owner && owner.accountId !== accountId) throw new Error('Device identity is already bound to another account')
      this.upsertAccountDevice({
        accountId,
        id: deviceId,
        name: String(pairing.androidDeviceName),
        type: 'android',
        publicKey: String(pairing.androidPublicKey),
      })
      return pairing
    })()
  }

  upsertEntitlement(input: Omit<StoredEntitlement, 'updatedAt'> & { updatedAt?: number }): boolean {
    const updatedAt = input.updatedAt || Date.now()
    const result = this.db.prepare(`INSERT INTO account_entitlements_v2
      (account_id,product,state,plan,expires_at,provider_subscription_id,provider_event_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,product) DO UPDATE SET
      state=excluded.state,plan=excluded.plan,expires_at=excluded.expires_at,
      provider_subscription_id=excluded.provider_subscription_id,provider_event_id=excluded.provider_event_id,
      updated_at=excluded.updated_at
      WHERE excluded.updated_at >= account_entitlements_v2.updated_at
        AND (excluded.provider_event_id IS NULL OR account_entitlements_v2.provider_event_id IS NULL
          OR excluded.provider_event_id <> account_entitlements_v2.provider_event_id)`)
      .run(input.accountId, input.product, input.state, input.plan || null, input.expiresAt || null,
        input.providerSubscriptionId || null, input.providerEventId || null, updatedAt)
    return result.changes > 0
  }

  getAccountTraffic(accountId: string, month: string): number {
    const row = this.db.prepare('SELECT bytes FROM account_traffic_v2 WHERE account_id=? AND month=?').get(accountId, month) as { bytes: number } | undefined
    return row?.bytes || 0
  }

  addAccountTraffic(rows: { accountId: string; month: string; bytes: number }[]): void {
    const now = Date.now()
    const add = this.db.prepare(`INSERT INTO account_traffic_v2(account_id,month,bytes,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,month) DO UPDATE SET bytes=bytes+excluded.bytes, updated_at=excluded.updated_at`)
    this.db.transaction(() => { for (const row of rows) add.run(row.accountId, row.month, row.bytes, now) })()
  }

  listEntitlements(accountId: string): StoredEntitlement[] {
    return this.db.prepare(`SELECT account_id AS accountId,product,state,plan,expires_at AS expiresAt,
      provider_subscription_id AS providerSubscriptionId,provider_event_id AS providerEventId,updated_at AS updatedAt
      FROM account_entitlements_v2 WHERE account_id=? ORDER BY product`).all(accountId) as StoredEntitlement[]
  }

  upsertDevice(input: { id: string; name: string; type: DeviceType; publicKey?: string }): void {
    const now = Date.now()
    this.db.prepare(`INSERT INTO devices(id,name,type,public_key,last_seen_at,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,type=excluded.type,public_key=COALESCE(excluded.public_key,devices.public_key),
      last_seen_at=excluded.last_seen_at,revoked_at=NULL`).run(
      input.id, input.name, input.type, input.publicKey || null, now, now,
    )
  }

  setRefresh(deviceId: string, hash: string, expiresAt: number): void {
    this.db.prepare('UPDATE devices SET refresh_hash=?,refresh_expires_at=? WHERE id=?')
      .run(hash, expiresAt, deviceId)
  }

  getDevice(deviceId: string): (AuthDevice & { refresh_hash: string | null; refresh_expires_at: number | null }) | undefined {
    return this.db.prepare(`SELECT id,name,type,revoked_at AS revokedAt,
      refresh_hash,refresh_expires_at FROM devices WHERE id=?`).get(deviceId) as never
  }

  listDevices(): AuthDevice[] {
    return this.db.prepare('SELECT id,name,type,revoked_at AS revokedAt FROM devices ORDER BY created_at')
      .all() as AuthDevice[]
  }

  revokeDevice(deviceId: string): void {
    this.db.prepare('UPDATE devices SET revoked_at=?,refresh_hash=NULL WHERE id=?').run(Date.now(), deviceId)
  }

  appendEvent(frame: EncryptedFrame, sourceDeviceId: string): number {
    const result = this.db.prepare(`INSERT OR IGNORE INTO events
      (id,source_device_id,target_device_id,kind,thread_id,nonce,ciphertext,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(frame.id, sourceDeviceId, frame.targetDeviceId || null,
        frame.kind, frame.threadId || null, frame.nonce, frame.ciphertext, frame.createdAt || Date.now())
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT sequence FROM events WHERE id=?').get(frame.id) as { sequence: number }
      return row.sequence
    }
    return Number(result.lastInsertRowid)
  }

  listEvents(deviceId: string, after: number, limit: number): EncryptedFrame[] {
    return this.db.prepare(`SELECT sequence,id,source_device_id AS sourceDeviceId,
      target_device_id AS targetDeviceId,kind,thread_id AS threadId,nonce,ciphertext,created_at AS createdAt
      FROM events WHERE sequence>? AND source_device_id<>?
      AND (target_device_id IS NULL OR target_device_id=?) ORDER BY sequence LIMIT ?`)
      .all(after, deviceId, deviceId, limit) as EncryptedFrame[]
  }

  latestEventSequence(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get() as { sequence: number }).sequence
  }

  upsertThread(input: { id: string; connectorId: string; nonce: string; ciphertext: string; archived: boolean; updatedAt: number }): void {
    this.db.prepare(`INSERT INTO history_threads(id,connector_id,nonce,ciphertext,archived,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET connector_id=excluded.connector_id,
      nonce=excluded.nonce,ciphertext=excluded.ciphertext,archived=excluded.archived,updated_at=excluded.updated_at`)
      .run(input.id, input.connectorId, input.nonce, input.ciphertext, input.archived ? 1 : 0, input.updatedAt)
  }

  listThreads(before: number | null, limit: number): unknown[] {
    return this.db.prepare(`SELECT id,connector_id AS connectorId,nonce,ciphertext,archived,updated_at AS updatedAt
      FROM history_threads WHERE (? IS NULL OR updated_at<?) ORDER BY updated_at DESC LIMIT ?`)
      .all(before, before, limit)
  }

  upsertItems(threadId: string, items: Array<{ id: string; order: number; nonce: string; ciphertext: string; createdAt: number }>): void {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO history_items
      (id,thread_id,item_order,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?)`)
    this.db.transaction(() => items.forEach((i) => stmt.run(i.id, threadId, i.order, i.nonce, i.ciphertext, i.createdAt)))()
  }

  listItems(threadId: string, before: number | null, limit: number, after: number | null = null): unknown[] {
    if (after !== null) {
      return this.db.prepare(`SELECT id,item_order AS itemOrder,nonce,ciphertext,created_at AS createdAt
        FROM history_items WHERE thread_id=? AND item_order>?
        ORDER BY item_order ASC LIMIT ?`).all(threadId, after, limit)
    }
    return this.db.prepare(`SELECT id,item_order AS itemOrder,nonce,ciphertext,created_at AS createdAt
      FROM history_items WHERE thread_id=? AND (? IS NULL OR item_order<?)
      ORDER BY item_order DESC LIMIT ?`).all(threadId, before, before, limit)
  }

  appendAccountEvent(accountId: string, frame: EncryptedFrame, sourceDeviceId: string): number {
    const result = this.db.prepare(`INSERT OR IGNORE INTO account_events_v2
      (account_id,id,source_device_id,target_device_id,kind,thread_id,nonce,ciphertext,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(accountId, frame.id, sourceDeviceId, frame.targetDeviceId || null,
        frame.kind, frame.threadId || null, frame.nonce, frame.ciphertext, frame.createdAt || Date.now())
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT sequence FROM account_events_v2 WHERE account_id=? AND id=?').get(accountId, frame.id) as { sequence: number }
      return row.sequence
    }
    return Number(result.lastInsertRowid)
  }

  listAccountEvents(accountId: string, deviceId: string, after: number, limit: number): EncryptedFrame[] {
    return this.db.prepare(`SELECT sequence,id,source_device_id AS sourceDeviceId,target_device_id AS targetDeviceId,
      kind,thread_id AS threadId,nonce,ciphertext,created_at AS createdAt FROM account_events_v2
      WHERE account_id=? AND sequence>? AND source_device_id<>?
      AND (target_device_id IS NULL OR target_device_id=?) ORDER BY sequence LIMIT ?`)
      .all(accountId, after, deviceId, deviceId, limit) as EncryptedFrame[]
  }

  latestAccountEventSequence(accountId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM account_events_v2 WHERE account_id=?')
      .get(accountId) as { sequence: number }).sequence
  }

  /** False when the thread was deleted and this upload is not newer than that: it is dropped. */
  upsertAccountThread(accountId: string, input: { id: string; connectorId: string; nonce: string; ciphertext: string; archived: boolean; updatedAt: number }): boolean {
    const deletedAt = this.accountThreadDeletedAt(accountId, input.id)
    if (deletedAt !== null) {
      if (input.updatedAt <= deletedAt) return false
      // New activity after the deletion: the conversation is back, from here on.
      this.db.prepare('DELETE FROM account_history_deleted_v2 WHERE account_id=? AND thread_id=?').run(accountId, input.id)
    }
    // Strictly increasing per account, so a phone's cursor never skips a row
    // stored in the same millisecond as the last one it saw.
    const changedAt = Math.max(Date.now(), this.accountThreadsCursor(accountId) + 1)
    this.db.prepare(`INSERT INTO account_history_changed_v2 (account_id,changed_at) VALUES(?,?)
      ON CONFLICT(account_id) DO UPDATE SET changed_at=excluded.changed_at`).run(accountId, changedAt)
    this.db.prepare(`INSERT INTO account_history_threads_v2
      (account_id,id,connector_id,nonce,ciphertext,archived,updated_at,changed_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,id) DO UPDATE SET connector_id=excluded.connector_id,nonce=excluded.nonce,
      ciphertext=excluded.ciphertext,archived=excluded.archived,updated_at=excluded.updated_at,changed_at=excluded.changed_at`)
      .run(accountId, input.id, input.connectorId, input.nonce, input.ciphertext, input.archived ? 1 : 0, input.updatedAt, changedAt)
    return true
  }

  private accountThreadDeletedAt(accountId: string, threadId: string): number | null {
    const row = this.db.prepare('SELECT deleted_at AS deletedAt FROM account_history_deleted_v2 WHERE account_id=? AND thread_id=?')
      .get(accountId, threadId) as { deletedAt: number } | undefined
    return row ? row.deletedAt : null
  }

  accountThreadTrimmedBefore(accountId: string, threadId: string): number | null {
    const row = this.db.prepare('SELECT trimmed_before AS trimmedBefore FROM account_history_trimmed_v2 WHERE account_id=? AND thread_id=?')
      .get(accountId, threadId) as { trimmedBefore: number } | undefined
    return row ? row.trimmedBefore : null
  }

  /**
   * Remove a conversation's items but keep the conversation: everything below
   * the newest `keepLast` items goes, and the cut is remembered so phones show
   * that older history was cleared and connectors cannot upload it again.
   */
  trimAccountThreads(accountId: string, threadIds: string[], options: { keepLast?: number; at?: number } = {}): { threads: number; items: number } {
    const keepLast = Math.max(0, options.keepLast ?? 0); const at = options.at ?? Date.now()
    const newest = this.db.prepare('SELECT item_order AS itemOrder FROM account_history_items_v2 WHERE account_id=? AND thread_id=? ORDER BY item_order DESC LIMIT 1 OFFSET ?')
    const highest = this.db.prepare('SELECT MAX(item_order) AS itemOrder FROM account_history_items_v2 WHERE account_id=? AND thread_id=?')
    const remove = this.db.prepare('DELETE FROM account_history_items_v2 WHERE account_id=? AND thread_id=? AND item_order<?')
    const mark = this.db.prepare(`INSERT INTO account_history_trimmed_v2 (account_id,thread_id,trimmed_before,trimmed_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,thread_id) DO UPDATE SET trimmed_before=MAX(trimmed_before,excluded.trimmed_before),trimmed_at=excluded.trimmed_at`)
    const exists = this.db.prepare('SELECT 1 FROM account_history_threads_v2 WHERE account_id=? AND id=?')
    const total = { threads: 0, items: 0 }
    this.db.transaction(() => {
      for (const id of threadIds) {
        if (!exists.get(accountId, id)) continue
        // The cut: just above the newest item removed (all of them with keepLast 0).
        const kept = keepLast > 0 ? newest.get(accountId, id, keepLast - 1) as { itemOrder: number } | undefined : undefined
        const top = highest.get(accountId, id) as { itemOrder: number | null }
        if (top.itemOrder === null) continue
        const cut = kept ? kept.itemOrder : top.itemOrder + 1
        const removed = remove.run(accountId, id, cut).changes
        if (!removed) continue
        mark.run(accountId, id, cut, at)
        total.threads += 1; total.items += removed
      }
    })()
    return total
  }

  /** Events older than `before` (ms), for every account: phones and connectors only read events after their last one. */
  pruneAccountEvents(before: number): { events: number } {
    return { events: this.db.prepare('DELETE FROM account_events_v2 WHERE created_at<?').run(before).changes }
  }

  measureAccountEventsBefore(before: number): { events: number; eventBytes: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ciphertext)),0) AS bytes FROM account_events_v2 WHERE created_at<?').get(before) as { n: number; bytes: number }
    return { events: row.n, eventBytes: row.bytes }
  }

  listAccountDeletedThreads(accountId: string): Array<{ id: string; deletedAt: number }> {
    return this.db.prepare('SELECT thread_id AS id, deleted_at AS deletedAt FROM account_history_deleted_v2 WHERE account_id=? ORDER BY deleted_at DESC LIMIT 2000')
      .all(accountId) as Array<{ id: string; deletedAt: number }>
  }

  /** What deleting these threads frees: rows and stored bytes (ciphertext). */
  measureAccountThreads(accountId: string, threadIds: string[]): { threads: number; items: number; itemBytes: number; events: number; eventBytes: number } {
    const total = { threads: 0, items: 0, itemBytes: 0, events: 0, eventBytes: 0 }
    const thread = this.db.prepare('SELECT COUNT(*) AS n FROM account_history_threads_v2 WHERE account_id=? AND id=?')
    const items = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ciphertext)),0) AS bytes FROM account_history_items_v2 WHERE account_id=? AND thread_id=?')
    const events = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ciphertext)),0) AS bytes FROM account_events_v2 WHERE account_id=? AND thread_id=?')
    for (const id of threadIds) {
      total.threads += (thread.get(accountId, id) as { n: number }).n
      const i = items.get(accountId, id) as { n: number; bytes: number }; total.items += i.n; total.itemBytes += i.bytes
      const e = events.get(accountId, id) as { n: number; bytes: number }; total.events += e.n; total.eventBytes += e.bytes
    }
    return total
  }

  /**
   * Delete conversations from the relay: the thread rows with their items
   * (cascade), optionally their events, and a tombstone so connectors that
   * still have them do not upload them again.
   */
  deleteAccountThreads(accountId: string, threadIds: string[], options: { events?: boolean; at?: number } = {}): number {
    const at = options.at ?? Date.now()
    const tombstone = this.db.prepare(`INSERT INTO account_history_deleted_v2 (account_id,thread_id,deleted_at) VALUES(?,?,?)
      ON CONFLICT(account_id,thread_id) DO UPDATE SET deleted_at=excluded.deleted_at`)
    const thread = this.db.prepare('DELETE FROM account_history_threads_v2 WHERE account_id=? AND id=?')
    const events = this.db.prepare('DELETE FROM account_events_v2 WHERE account_id=? AND thread_id=?')
    let deleted = 0
    this.db.transaction(() => {
      for (const id of threadIds) {
        tombstone.run(accountId, id, at)
        deleted += thread.run(accountId, id).changes
        if (options.events) events.run(accountId, id)
      }
    })()
    return deleted
  }

  /** The newest change stamp given out for the account's conversation rows (0 when none). */
  accountThreadsCursor(accountId: string): number {
    return (this.db.prepare(`SELECT MAX(
      COALESCE((SELECT changed_at FROM account_history_changed_v2 WHERE account_id=?),0),
      COALESCE((SELECT MAX(changed_at) FROM account_history_threads_v2 WHERE account_id=?),0)) AS c`).get(accountId, accountId) as { c: number }).c
  }

  /**
   * Rows stored after `since`, oldest change first, and the cursor to ask
   * from next: the last row's stamp when the page is full, else the newest.
   */
  listAccountThreadsChangedSince(accountId: string, since: number, limit: number): { items: unknown[]; cursor: number; more: boolean } {
    const rows = this.db.prepare(`SELECT id,connector_id AS connectorId,nonce,ciphertext,archived,updated_at AS updatedAt,changed_at AS changedAt
      FROM account_history_threads_v2 WHERE account_id=? AND changed_at>? ORDER BY changed_at ASC LIMIT ?`).all(accountId, since, limit) as Array<{ changedAt: number }>
    const more = rows.length >= limit
    const cursor = more ? rows[rows.length - 1].changedAt : Math.max(since, this.accountThreadsCursor(accountId))
    return { items: rows.map(({ changedAt: _changedAt, ...row }) => row), cursor, more }
  }

  listAccountDeletedThreadsSince(accountId: string, since: number): Array<{ id: string; deletedAt: number }> {
    return this.db.prepare('SELECT thread_id AS id, deleted_at AS deletedAt FROM account_history_deleted_v2 WHERE account_id=? AND deleted_at>? ORDER BY deleted_at DESC LIMIT 2000')
      .all(accountId, since) as Array<{ id: string; deletedAt: number }>
  }

  listAccountThreads(accountId: string, before: number | null, limit: number): unknown[] {
    return this.db.prepare(`SELECT id,connector_id AS connectorId,nonce,ciphertext,archived,updated_at AS updatedAt
      FROM account_history_threads_v2 WHERE account_id=? AND (? IS NULL OR updated_at<?)
      ORDER BY updated_at DESC LIMIT ?`).all(accountId, before, before, limit)
  }

  /**
   * Returns how many items were saved. For a deleted thread, items no newer
   * than the deletion are dropped; for a trimmed one, items below the cut (a
   * connector rebuilding the whole conversation) are dropped.
   */
  upsertAccountItems(accountId: string, threadId: string, items: Array<{ id: string; order: number; nonce: string; ciphertext: string; createdAt: number }>): number {
    const deletedAt = this.accountThreadDeletedAt(accountId, threadId)
    if (deletedAt !== null) {
      items = items.filter((item) => item.createdAt > deletedAt)
      // Newer items wait for the thread to come back (its own upload); the
      // connector retries them, as for any failed upload.
      if (items.length) throw new ConflictException('Thread was deleted; upload the thread first')
      return 0
    }
    const trimmedBefore = this.accountThreadTrimmedBefore(accountId, threadId)
    if (trimmedBefore !== null) items = items.filter((item) => item.order >= trimmedBefore)
    if (!items.length) return 0
    const removeOrder = this.db.prepare(`DELETE FROM account_history_items_v2 WHERE account_id=? AND thread_id=? AND item_order=? AND id<>?`)
    const save = this.db.prepare(`INSERT INTO account_history_items_v2
      (account_id,thread_id,id,item_order,nonce,ciphertext,created_at,changed_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,thread_id,id) DO UPDATE SET item_order=excluded.item_order,nonce=excluded.nonce,
      ciphertext=excluded.ciphertext,created_at=excluded.created_at,changed_at=excluded.changed_at`)
    const stamp = this.db.prepare(`INSERT INTO account_history_items_changed_v2 (account_id,changed_at) VALUES(?,?)
      ON CONFLICT(account_id) DO UPDATE SET changed_at=excluded.changed_at`)
    this.db.transaction(() => {
      // One strictly increasing stamp per row, so a page that ends inside a
      // batch never makes the phone skip the rest of it.
      let changedAt = Math.max(Date.now(), this.accountItemsCursor(accountId) + 1)
      items.forEach((item) => {
        removeOrder.run(accountId, threadId, item.order, item.id)
        save.run(accountId, threadId, item.id, item.order, item.nonce, item.ciphertext, item.createdAt, changedAt)
        changedAt += 1
      })
      stamp.run(accountId, changedAt - 1)
    })()
    return items.length
  }

  /** The last item stamp given out for this account (0 before any). */
  accountItemsCursor(accountId: string): number {
    const row = this.db.prepare('SELECT changed_at AS c FROM account_history_items_changed_v2 WHERE account_id=?').get(accountId) as { c: number } | undefined
    return row ? row.c : 0
  }

  /** Items of one conversation stored after `since`, oldest change first, and the cursor to ask from next. */
  listAccountItemsChangedSince(accountId: string, threadId: string, since: number, limit: number): { items: unknown[]; cursor: number; more: boolean } {
    const cursorBefore = this.accountItemsCursor(accountId)
    const rows = this.db.prepare(`SELECT id,item_order AS itemOrder,nonce,ciphertext,created_at AS createdAt,changed_at AS changedAt
      FROM account_history_items_v2 WHERE account_id=? AND thread_id=? AND changed_at>? ORDER BY changed_at ASC LIMIT ?`)
      .all(accountId, threadId, since, limit) as Array<{ changedAt: number }>
    const more = rows.length >= limit
    const cursor = more ? rows[rows.length - 1].changedAt : Math.max(since, cursorBefore)
    return { items: rows.map(({ changedAt: _changedAt, ...row }) => row), cursor, more }
  }

  listAccountItems(accountId: string, threadId: string, before: number | null, limit: number, after: number | null = null): unknown[] {
    if (after !== null) {
      return this.db.prepare(`SELECT id,item_order AS itemOrder,nonce,ciphertext,created_at AS createdAt
        FROM account_history_items_v2 WHERE account_id=? AND thread_id=? AND item_order>?
        ORDER BY item_order ASC LIMIT ?`).all(accountId, threadId, after, limit)
    }
    return this.db.prepare(`SELECT id,item_order AS itemOrder,nonce,ciphertext,created_at AS createdAt
      FROM account_history_items_v2 WHERE account_id=? AND thread_id=? AND (? IS NULL OR item_order<?)
      ORDER BY item_order DESC LIMIT ?`).all(accountId, threadId, before, before, limit)
  }
}
