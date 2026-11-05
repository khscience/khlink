import { BadRequestException, Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthRequest } from './auth.guard'
import { DatabaseService } from './database.service'

function bounded(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, Math.trunc(parsed))) : fallback
}

@Controller('v1/history')
@UseGuards(AuthGuard)
export class HistoryController {
  constructor(private readonly database: DatabaseService) {}

  @Get('threads')
  threads(@Query('before') before: string | undefined, @Query('limit') limit: string | undefined): object {
    return { items: this.database.listThreads(before ? Number(before) : null, bounded(limit, 30, 100)) }
  }

  @Put('threads')
  putThread(@Req() req: AuthRequest, @Body() body: { id: string; nonce: string; ciphertext: string; archived?: boolean; updatedAt?: number }): object {
    if (req.claims.type !== 'connector') throw new BadRequestException('Only connector can sync history')
    this.database.upsertThread({ id: body.id, connectorId: req.claims.deviceId, nonce: body.nonce,
      ciphertext: body.ciphertext, archived: body.archived === true, updatedAt: body.updatedAt || Date.now() })
    return { saved: true }
  }

  @Get('threads/:threadId/items')
  items(@Param('threadId') threadId: string, @Query('before') before: string | undefined,
    @Query('after') after: string | undefined, @Query('limit') limit: string | undefined): object {
    if (before !== undefined && after !== undefined) throw new BadRequestException('Use before or after, not both')
    const pageLimit = bounded(limit, 30, 100)
    const rows = this.database.listItems(threadId, before ? Number(before) : null, pageLimit + 1,
      after ? Number(after) : null)
    return { items: rows.slice(0, pageLimit), hasMore: rows.length > pageLimit }
  }

  @Put('threads/:threadId/items')
  putItems(@Req() req: AuthRequest, @Param('threadId') threadId: string,
    @Body() body: { items: Array<{ id: string; order: number; nonce: string; ciphertext: string; createdAt: number }> }): object {
    if (req.claims.type !== 'connector') throw new BadRequestException('Only connector can sync history')
    if (!Array.isArray(body.items) || body.items.length > 100) throw new BadRequestException('Invalid batch')
    this.database.upsertItems(threadId, body.items)
    return { saved: body.items.length }
  }
}
