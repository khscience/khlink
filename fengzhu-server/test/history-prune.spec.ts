import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseService } from '../src/database.service'
import type { EncryptedFrame } from '../src/types'

describe('deleting conversations from the relay', () => {
  let directory: string
  let previousPath: string | undefined
  let database: DatabaseService
  let account: string
  const thread = (id: string, updatedAt: number) => ({ id, connectorId: 'pc-a', nonce: 'n', ciphertext: 'thread', archived: false, updatedAt })
  const item = (id: string, order: number, createdAt: number) => ({ id, order, nonce: 'n', ciphertext: 'x'.repeat(100), createdAt })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fengzhu-prune-'))
    previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    database = new DatabaseService()
    database.onModuleInit()
    account = database.upsertAccount({ subject: 'wp-1', displayName: 'A', disabled: false })
    database.upsertAccountThread(account, thread('old', 100))
    database.upsertAccountItems(account, 'old', [item('a', 1, 90), item('b', 2, 95)])
    database.upsertAccountThread(account, thread('kept', 100))
    database.upsertAccountItems(account, 'kept', [item('c', 1, 90)])
    const event = { id: 'e1', kind: 'history.updated', threadId: 'old', nonce: 'n', ciphertext: 'event', createdAt: 99 } as EncryptedFrame
    database.appendAccountEvent(account, event, 'pc-a')
  })

  afterEach(() => {
    database.onModuleDestroy()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  it('measures, then deletes threads with their items and events, leaving others', () => {
    expect(database.measureAccountThreads(account, ['old', 'missing'])).toEqual({ threads: 1, items: 2, itemBytes: 200, events: 1, eventBytes: 5 })
    expect(database.deleteAccountThreads(account, ['old', 'missing'], { events: true, at: 1000 })).toBe(1)
    expect(database.measureAccountThreads(account, ['old'])).toEqual({ threads: 0, items: 0, itemBytes: 0, events: 0, eventBytes: 0 })
    expect(database.listAccountItems(account, 'kept', null, 30)).toHaveLength(1)
    expect(database.listAccountDeletedThreads(account).map((row) => row.id).sort()).toEqual(['missing', 'old'])
  })

  it('trims a conversation: items go, the conversation stays, uploads below the cut are dropped', () => {
    database.upsertAccountItems(account, 'old', [item('c', 3, 96)])
    expect(database.trimAccountThreads(account, ['old', 'missing'], { keepLast: 1 })).toEqual({ threads: 1, items: 2 })
    expect(database.accountThreadTrimmedBefore(account, 'old')).toBe(3)
    expect(database.listAccountItems(account, 'old', null, 30).map((row) => (row as { id: string }).id)).toEqual(['c'])
    expect(database.listAccountThreads(account, null, 30)).toHaveLength(2)
    // A connector rebuilding the whole conversation: the old part is dropped, new items are kept.
    expect(database.upsertAccountItems(account, 'old', [item('a', 1, 90), item('b', 2, 95), item('d', 4, 3000)])).toBe(1)
    expect(database.listAccountItems(account, 'old', null, 30)).toHaveLength(2)
    // Trimming everything of a conversation keeps its row and moves the cut up.
    expect(database.trimAccountThreads(account, ['old'])).toEqual({ threads: 1, items: 2 })
    expect(database.accountThreadTrimmedBefore(account, 'old')).toBe(5)
    expect(database.listAccountItems(account, 'old', null, 30)).toEqual([])
    expect(database.trimAccountThreads(account, ['old'])).toEqual({ threads: 0, items: 0 })
  })

  it('prunes events older than a time, for every account', () => {
    const event = { id: 'e2', kind: 'history.updated', threadId: 'kept', nonce: 'n', ciphertext: 'event', createdAt: 5000 } as EncryptedFrame
    database.appendAccountEvent(account, event, 'pc-a')
    expect(database.measureAccountEventsBefore(1000)).toEqual({ events: 1, eventBytes: 5 })
    expect(database.pruneAccountEvents(1000)).toEqual({ events: 1 })
    expect(database.measureAccountThreads(account, ['kept']).events).toBe(1)
  })

  it('drops a connector re-sending a deleted thread, and takes it back after new activity', () => {
    database.deleteAccountThreads(account, ['old'], { at: 1000 })
    // The connector still has it: the same thread and its old items come back.
    expect(database.upsertAccountThread(account, thread('old', 100))).toBe(false)
    expect(database.upsertAccountItems(account, 'old', [item('a', 1, 90)])).toBe(0)
    expect(database.listAccountThreads(account, null, 30).map((row) => (row as { id: string }).id)).toEqual(['kept'])
    // Newer items before the thread itself: the connector retries them later.
    expect(() => database.upsertAccountItems(account, 'old', [item('d', 3, 2000)])).toThrow('Thread was deleted')
    // New activity after the deletion brings the conversation back, from here on.
    expect(database.upsertAccountThread(account, thread('old', 2000))).toBe(true)
    expect(database.upsertAccountItems(account, 'old', [item('d', 3, 2000)])).toBe(1)
    expect(database.listAccountDeletedThreads(account)).toEqual([])
    expect(database.listAccountItems(account, 'old', null, 30)).toHaveLength(1)
  })
})
