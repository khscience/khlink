// Clean up the relay's history.
//
//   SQLITE_PATH=/path/to/fengzhu-bridge.db node dist/src/prune-history.js --list prune.json --events-days 7 --dry-run
//   SQLITE_PATH=/path/to/fengzhu-bridge.db node dist/src/prune-history.js --list prune.json --events-days 7
//
// prune.json is written by fengzhu-connect/scripts/history-prune-list.js on a
// computer that holds the account key (the relay cannot read archive state or
// pins): {"accountId": "...", "deleteThreadIds": [...], "trimThreadIds": [...]}.
// - deleteThreadIds (archived): deleted whole, with their items and events,
//   and a tombstone so connectors do not upload them again;
// - trimThreadIds (idle): items removed, conversation kept; the cut is
//   remembered (phones show older history as cleared, uploads below it are
//   dropped). --keep-last N keeps the newest N items of each (default 0);
// - --events-days N: events older than N days are removed, for every account.
// Run VACUUM afterwards to shrink the file.
import { readFileSync } from 'node:fs'
import { DatabaseService } from './database.service'

function main(): void {
  const args = process.argv.slice(2)
  const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const listFile = value('--list')
  const eventsDays = value('--events-days') === undefined ? null : Number(value('--events-days'))
  const keepLast = Number(value('--keep-last') ?? 0)
  const dryRun = args.includes('--dry-run')
  if (!listFile || (eventsDays !== null && !(eventsDays > 0)) || !(keepLast >= 0)) {
    throw new Error('usage: prune-history.js --list prune.json [--events-days 7] [--keep-last 0] [--dry-run]')
  }
  const list = JSON.parse(readFileSync(listFile, 'utf8')) as { accountId?: string; deleteThreadIds?: string[]; trimThreadIds?: string[] }
  const ids = (values?: string[]) => [...new Set((values || []).filter((id) => typeof id === 'string' && id))]
  const accountId = String(list.accountId || '')
  const remove = ids(list.deleteThreadIds)
  const trim = ids(list.trimThreadIds).filter((id) => !remove.includes(id))
  if (!accountId) throw new Error(`${listFile}: needs accountId`)
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  const database = new DatabaseService()
  database.onModuleInit()
  try {
    const removing = database.measureAccountThreads(accountId, remove)
    const trimming = database.measureAccountThreads(accountId, trim)
    const eventsBefore = eventsDays === null ? null : Date.now() - eventsDays * 86_400_000
    const oldEvents = eventsBefore === null ? null : database.measureAccountEventsBefore(eventsBefore)
    console.log(`account ${accountId}`)
    console.log(`  delete: ${remove.length} ids, ${removing.threads} on the relay, ${removing.items} items (${mb(removing.itemBytes)}), ${removing.events} events (${mb(removing.eventBytes)})`)
    console.log(`  trim:   ${trim.length} ids, ${trimming.threads} on the relay, up to ${trimming.items} items (${mb(trimming.itemBytes)})${keepLast ? `, keeping the newest ${keepLast} of each` : ''}`)
    if (oldEvents) console.log(`  events older than ${eventsDays} days (all accounts): ${oldEvents.events} (${mb(oldEvents.eventBytes)})`)
    if (dryRun) { console.log('dry run: nothing changed'); return }
    const deleted = database.deleteAccountThreads(accountId, remove, { events: true })
    const trimmed = database.trimAccountThreads(accountId, trim, { keepLast })
    const pruned = eventsBefore === null ? null : database.pruneAccountEvents(eventsBefore)
    console.log(`deleted ${deleted} conversations (${remove.length} tombstones); trimmed ${trimmed.threads} conversations, ${trimmed.items} items${pruned ? `; removed ${pruned.events} events` : ''}`)
    console.log('now run VACUUM to shrink the database file')
  } finally {
    database.onModuleDestroy()
  }
}

main()
