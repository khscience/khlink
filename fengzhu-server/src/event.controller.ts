import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthRequest } from './auth.guard'
import { DatabaseService } from './database.service'
import type { EncryptedFrame } from './types'

@Controller('v1/events')
@UseGuards(AuthGuard)
export class EventController {
  constructor(private readonly database: DatabaseService) {}
  @Get()
  list(@Req() req: AuthRequest, @Query('after') after?: string, @Query('limit') limit?: string): object {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100))
    return { items: this.database.listEvents(req.claims.deviceId, Number(after) || 0, bounded) }
  }
}
