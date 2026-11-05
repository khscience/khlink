import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseService } from '../src/database.service'

describe('history item persistence', () => {
  it('replaces an item when a replay assigns a new id to the same order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fengzhu-db-'))
    const previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    const database = new DatabaseService()

    try {
      database.onModuleInit()
      database.upsertThread({ id: 'thread-1', connectorId: 'connector-1', nonce: 'n', ciphertext: 'c', archived: false, updatedAt: 1 })
      database.upsertItems('thread-1', [{ id: 'old-id', order: 7, nonce: 'old-nonce', ciphertext: 'old', createdAt: 1 }])
      database.upsertItems('thread-1', [{ id: 'new-id', order: 7, nonce: 'new-nonce', ciphertext: 'new', createdAt: 2 }])

      expect(database.listItems('thread-1', null, 30)).toEqual([
        { id: 'new-id', itemOrder: 7, nonce: 'new-nonce', ciphertext: 'new', createdAt: 2 },
      ])
    } finally {
      database.onModuleDestroy()
      if (previousPath === undefined) delete process.env.SQLITE_PATH
      else process.env.SQLITE_PATH = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('can read one extra history item to determine whether an older page exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fengzhu-db-page-'))
    const previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    const database = new DatabaseService()

    try {
      database.onModuleInit()
      database.upsertThread({ id: 'thread-1', connectorId: 'connector-1', nonce: 'n', ciphertext: 'c', archived: false, updatedAt: 1 })
      database.upsertItems('thread-1', [1, 2, 3, 4].map((order) => ({ id: `item-${order}`, order, nonce: 'n', ciphertext: 'c', createdAt: order })))

      const firstPage = database.listItems('thread-1', null, 3) as Array<{ itemOrder: number }>
      const olderPage = database.listItems('thread-1', firstPage[1].itemOrder, 3) as Array<{ itemOrder: number }>
      expect(firstPage.map((item) => item.itemOrder)).toEqual([4, 3, 2])
      expect(olderPage.map((item) => item.itemOrder)).toEqual([2, 1])
    } finally {
      database.onModuleDestroy()
      if (previousPath === undefined) delete process.env.SQLITE_PATH
      else process.env.SQLITE_PATH = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('can read the forward range needed to recover a disconnected mobile cache', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fengzhu-db-forward-'))
    const previousPath = process.env.SQLITE_PATH
    process.env.SQLITE_PATH = join(directory, 'bridge.db')
    const database = new DatabaseService()

    try {
      database.onModuleInit()
      database.upsertThread({ id: 'thread-1', connectorId: 'connector-1', nonce: 'n', ciphertext: 'c', archived: false, updatedAt: 1 })
      database.upsertItems('thread-1', [1, 2, 3, 4, 5].map((order) => ({ id: `item-${order}`, order, nonce: 'n', ciphertext: 'c', createdAt: order })))

      const recovered = database.listItems('thread-1', null, 3, 2) as Array<{ itemOrder: number }>
      expect(recovered.map((item) => item.itemOrder)).toEqual([3, 4, 5])
    } finally {
      database.onModuleDestroy()
      if (previousPath === undefined) delete process.env.SQLITE_PATH
      else process.env.SQLITE_PATH = previousPath
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
