import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { V2AuthGuard, type V2Request } from './v2-auth.guard'

@Controller('v2/events')
@UseGuards(V2AuthGuard)
export class V2EventController {
  constructor(private readonly database: DatabaseService) {}
  @Get()
  list(@Req() req: V2Request, @Query('after') after?: string, @Query('limit') limit?: string): object {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100))
    return { items: this.database.listAccountEvents(req.accountClaims.sub, req.accountClaims.deviceId, Number(after) || 0, bounded) }
  }
}
