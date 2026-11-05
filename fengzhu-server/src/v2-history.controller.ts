import { BadRequestException, Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { V2AuthGuard, type V2Request } from './v2-auth.guard'

function bounded(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, Math.trunc(parsed))) : fallback
}

const DELETED_MARGIN_MS = 5 * 60 * 1000

@Controller('v2/history')
@UseGuards(V2AuthGuard)
export class V2HistoryController {
  constructor(private readonly database: DatabaseService) {}

  @Get('threads')
  threads(@Req() req: V2Request, @Query('before') before?: string, @Query('limit') limit?: string, @Query('since') since?: string): object {
    const account = req.accountClaims.sub
    // Only what changed since the phone's cursor, with deletions of the last
    // few minutes around it (stamped with the clock, not the cursor).
    const sinceAt = since !== undefined ? Number(since) : NaN
    if (Number.isFinite(sinceAt) && sinceAt >= 0) {
      const page = this.database.listAccountThreadsChangedSince(account, sinceAt, bounded(limit, 30, 100))
      return { ...page, deleted: this.database.listAccountDeletedThreadsSince(account, sinceAt - DELETED_MARGIN_MS) }
    }
    // The cursor is read before the page, so a row stored in between is
    // fetched again rather than missed.
    const cursor = before ? undefined : this.database.accountThreadsCursor(account)
    const items = this.database.listAccountThreads(account, before ? Number(before) : null, bounded(limit, 30, 100))
    // The first page also names conversations deleted on the relay, so phones
    // drop their copies (older apps ignore the field), and gives the cursor
    // to ask for changes from.
    return before ? { items } : { items, deleted: this.database.listAccountDeletedThreads(account), cursor }
  }

  @Put('threads')
  putThread(@Req() req: V2Request, @Body() body: { id: string; nonce: string; ciphertext: string; archived?: boolean; updatedAt?: number }): object {
    if (req.accountClaims.type !== 'connector') throw new BadRequestException('Only connector can sync history')
    const saved = this.database.upsertAccountThread(req.accountClaims.sub, { id: body.id, connectorId: req.accountClaims.deviceId,
      nonce: body.nonce, ciphertext: body.ciphertext, archived: body.archived === true, updatedAt: body.updatedAt || Date.now() })
    // A deleted conversation re-sent unchanged is accepted and dropped.
    return { saved }
  }

  @Get('threads/:threadId/items')
  items(@Req() req: V2Request, @Param('threadId') threadId: string, @Query('before') before?: string,
    @Query('after') after?: string, @Query('limit') limit?: string, @Query('changedSince') changedSince?: string): object {
    if (before !== undefined && after !== undefined) throw new BadRequestException('Use before or after, not both')
    const pageLimit = bounded(limit, 30, 100)
    // An open conversation's refresh: only the items stored since the phone's
    // cursor (new ones and ones changed in place).
    if (changedSince !== undefined) {
      const since = Number(changedSince)
      if (!Number.isFinite(since) || since < 0) throw new BadRequestException('Invalid changedSince')
      const page = this.database.listAccountItemsChangedSince(req.accountClaims.sub, threadId, since, pageLimit)
      const trimmed = this.database.accountThreadTrimmedBefore(req.accountClaims.sub, threadId)
      return { ...page, ...(trimmed !== null ? { trimmedBefore: trimmed } : {}) }
    }
    // Taken before the rows: an item stored meanwhile is still after it.
    const cursor = this.database.accountItemsCursor(req.accountClaims.sub)
    const rows = this.database.listAccountItems(req.accountClaims.sub, threadId, before ? Number(before) : null,
      pageLimit + 1, after ? Number(after) : null)
    // Older items removed by a clean-up: phones drop their copies below the
    // cut and say so instead of paging further (older apps ignore it).
    const trimmedBefore = this.database.accountThreadTrimmedBefore(req.accountClaims.sub, threadId)
    return { items: rows.slice(0, pageLimit), hasMore: rows.length > pageLimit, cursor, ...(trimmedBefore !== null ? { trimmedBefore } : {}) }
  }

  @Put('threads/:threadId/items')
  putItems(@Req() req: V2Request, @Param('threadId') threadId: string,
    @Body() body: { items: Array<{ id: string; order: number; nonce: string; ciphertext: string; createdAt: number }> }): object {
    if (req.accountClaims.type !== 'connector') throw new BadRequestException('Only connector can sync history')
    if (!Array.isArray(body.items) || body.items.length > 100) throw new BadRequestException('Invalid batch')
    return { saved: this.database.upsertAccountItems(req.accountClaims.sub, threadId, body.items) }
  }
}
