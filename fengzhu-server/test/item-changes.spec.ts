import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseService } from '../src/database.service'
import { V2HistoryController } from '../src/v2-history.controller'
import type { V2Request } from '../src/v2-auth.guard'

describe('an open conversation fetches only the items stored since its last look', () => {
  let directory: string
  let previousPath: string | undefined
  let database: DatabaseService
  let account: string
  const item = (id: string, order: number, ciphertext = 'c') => ({ id, order, nonce: 'n', ciphertext, createdAt: 1000 + order })
  const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id)

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fengzhu-item-changes-'))
    previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    database = new DatabaseService()
    database.onModuleInit()
    account = database.upsertAccount({ subject: 'wp-1', displayName: 'A', disabled: false })
    database.upsertAccountThread(account, { id: 't', connectorId: 'pc', nonce: 'n', ciphertext: 'x', archived: false, updatedAt: 1 })
  })

  afterEach(() => {
    database.onModuleDestroy()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns new items and items changed in place, nothing else', () => {
    database.upsertAccountItems(account, 't', [item('a', 1), item('b', 2)])
    const controller = new V2HistoryController(database)
    const request = { accountClaims: { sub: account, type: 'device' } } as unknown as V2Request
    const first = controller.items(request, 't') as { items: unknown[]; cursor: number }
    expect(ids(first.items)).toEqual(['b', 'a'])
    expect(first.cursor).toBeGreaterThan(0)
    expect(controller.items(request, 't', undefined, undefined, undefined, String(first.cursor))).toEqual({ items: [], cursor: first.cursor, more: false })
    database.upsertAccountItems(account, 't', [item('b', 2, 'longer output'), item('c', 3)])
    const changed = controller.items(request, 't', undefined, undefined, undefined, String(first.cursor)) as { items: Array<{ id: string; ciphertext: string }>; cursor: number; more: boolean }
    expect(changed.items.map((row) => [row.id, row.ciphertext])).toEqual([['b', 'longer output'], ['c', 'c']])
    expect(changed.more).toBe(false)
    expect(controller.items(request, 't', undefined, undefined, undefined, String(changed.cursor))).toEqual({ items: [], cursor: changed.cursor, more: false })
  })

  it('pages through one batch without skipping any of it', () => {
    database.upsertAccountItems(account, 't', Array.from({ length: 5 }, (_, i) => item(`i${i}`, i)))
    const seen: string[] = []
    let cursor = 0; let more = true
    while (more) {
      const page = database.listAccountItemsChangedSince(account, 't', cursor, 2)
      seen.push(...ids(page.items)); cursor = page.cursor; more = page.more
    }
    expect(seen).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
  })

  it('rejects a bad cursor', () => {
    const controller = new V2HistoryController(database)
    const request = { accountClaims: { sub: account, type: 'device' } } as unknown as V2Request
    expect(() => controller.items(request, 't', undefined, undefined, undefined, 'x')).toThrow('Invalid changedSince')
  })
})
