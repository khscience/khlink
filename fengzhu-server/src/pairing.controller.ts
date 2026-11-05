import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { PairingService } from './pairing.service'
import { V2AuthGuard, type V2Request } from './v2-auth.guard'
import { V2AuthService } from './v2-auth.service'

@Controller('v2/pairing')
export class PairingController {
  constructor(private readonly pairing: PairingService, private readonly database: DatabaseService, private readonly auth: V2AuthService) {}

  @Post() @UseGuards(V2AuthGuard)
  create(@Req() req: V2Request): object {
    if (req.accountClaims.type !== 'desktop') throw new BadRequestException('Only desktop can create pairing codes')
    return this.pairing.create(req.accountClaims.sub, req.accountClaims.deviceId)
  }

  @Post('claim')
  claim(@Body() body: { id: string; secret: string; deviceId: string; deviceName: string; publicKey: string }): object {
    return this.pairing.claim(body)
  }

  @Get(':id') @UseGuards(V2AuthGuard)
  status(@Req() req: V2Request, @Param('id') id: string): object {
    return this.pairing.status(req.accountClaims.sub, id)
  }

  @Post(':id/confirm') @UseGuards(V2AuthGuard)
  confirm(@Req() req: V2Request, @Param('id') id: string, @Body() body: { keyEnvelope: string }): object {
    if (req.accountClaims.type !== 'desktop') throw new BadRequestException('Only desktop can confirm phones')
    return this.pairing.confirm(req.accountClaims.sub, id, body.keyEnvelope)
  }

  @Post(':id/poll')
  poll(@Param('id') id: string, @Body() body: { secret: string }): object {
    const record = this.pairing.consume(id, body.secret)
    if (!record) return { status: 'pending' }
    const accountId = String(record.accountId)
    const deviceId = String(record.androidDeviceId)
    return { status: 'confirmed', profile: this.database.getAccount(accountId), keyEnvelope: record.keyEnvelope, session: this.auth.issue(accountId, deviceId, 'android') }
  }
}
