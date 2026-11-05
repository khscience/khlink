import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DatabaseService } from '../src/database.service'
import { V2HistoryController } from '../src/v2-history.controller'
import type { V2Request } from '../src/v2-auth.guard'

describe('phones fetch only the conversation rows that changed', () => {
  let directory: string
  let previousPath: string | undefined
  let database: DatabaseService
  let account: string
  const thread = (id: string, updatedAt: number, ciphertext = 'thread') => ({ id, connectorId: 'pc-a', nonce: 'n', ciphertext, archived: false, updatedAt })
  const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id)

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fengzhu-changes-'))
    previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    database = new DatabaseService()
    database.onModuleInit()
    account = database.upsertAccount({ subject: 'wp-1', displayName: 'A', disabled: false })
  })

  afterEach(() => {
    database.onModuleDestroy()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns rows stored after the cursor, even when the connector kept their updatedAt', () => {
    database.upsertAccountThread(account, thread('a', 100))
    database.upsertAccountThread(account, thread('b', 200))
    const cursor = database.accountThreadsCursor(account)
    expect(database.listAccountThreadsChangedSince(account, cursor, 100)).toEqual({ items: [], cursor, more: false })
    // Same updatedAt, new content (a status change): still a change.
    database.upsertAccountThread(account, thread('a', 100, 'waiting'))
    const page = database.listAccountThreadsChangedSince(account, cursor, 100)
    expect(ids(page.items)).toEqual(['a'])
    expect((page.items[0] as { ciphertext: string }).ciphertext).toBe('waiting')
    expect(page.cursor).toBeGreaterThan(cursor)
    expect(page.items[0]).not.toHaveProperty('changedAt')
  })

  it('stamps rows in strictly increasing order and pages through a burst', () => {
    for (let index = 0; index < 5; index += 1) database.upsertAccountThread(account, thread(`t${index}`, 100))
    const first = database.listAccountThreadsChangedSince(account, 0, 2)
    expect(ids(first.items)).toEqual(['t0', 't1'])
    expect(first.more).toBe(true)
    const second = database.listAccountThreadsChangedSince(account, first.cursor, 2)
    expect(ids(second.items)).toEqual(['t2', 't3'])
    const last = database.listAccountThreadsChangedSince(account, second.cursor, 2)
    expect(ids(last.items)).toEqual(['t4'])
    expect(last.more).toBe(false)
  })

  it('the first page gives a cursor; a since request gives changes and recent deletions', () => {
    const controller = new V2HistoryController(database)
    const request = { accountClaims: { sub: account, type: 'android', deviceId: 'phone' } } as unknown as V2Request
    database.upsertAccountThread(account, thread('a', 100))
    database.upsertAccountThread(account, thread('b', 100))
    const first = controller.threads(request) as { items: unknown[]; cursor: number; deleted: unknown[] }
    expect(ids(first.items).sort()).toEqual(['a', 'b'])
    expect(first.cursor).toBe(database.accountThreadsCursor(account))
    database.deleteAccountThreads(account, ['b'])
    database.upsertAccountThread(account, thread('c', 100))
    const next = controller.threads(request, undefined, undefined, String(first.cursor)) as { items: unknown[]; cursor: number; deleted: Array<{ id: string }> }
    expect(ids(next.items)).toEqual(['c'])
    expect(next.deleted.map((row) => row.id)).toEqual(['b'])
    expect(next.cursor).toBeGreaterThan(first.cursor)
  })

  it('stamps existing rows from their updatedAt when the column is added', () => {
    database.onModuleDestroy()
    const raw = new Database(process.env.SQLITE_PATH!)
    raw.exec('DROP INDEX IF EXISTS idx_account_history_threads_v2_changed')
    raw.exec('ALTER TABLE account_history_threads_v2 DROP COLUMN changed_at')
    raw.prepare(`INSERT INTO account_history_threads_v2 (account_id,id,connector_id,nonce,ciphertext,archived,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(account, 'legacy', 'pc-a', 'n', 'old', 0, 4242)
    raw.close()
    database = new DatabaseService()
    database.onModuleInit()
    expect(database.accountThreadsCursor(account)).toBe(4242)
    database.upsertAccountThread(account, thread('fresh', 1))
    expect(ids(database.listAccountThreadsChangedSince(account, 4242, 100).items)).toEqual(['fresh'])
  })
})
