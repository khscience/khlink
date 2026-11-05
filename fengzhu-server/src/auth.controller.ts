import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthRequest } from './auth.guard'
import { AuthService } from './auth.service'
import { DatabaseService } from './database.service'
import type { DeviceType } from './types'

@Controller('v1')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly database: DatabaseService) {}

  @Post('auth/challenge') challenge(): object { return this.auth.challenge() }

  @Post('auth/login') login(@Body() body: { challengeId: string; proof: string; deviceId: string; deviceName: string; deviceType: DeviceType; publicKey?: string; keyEnvelope?: { nonce: string; ciphertext: string } }): object {
    return this.auth.login(body)
  }

  @Post('auth/change-password') @UseGuards(AuthGuard)
  changePassword(@Body() body: { salt: string; verifier: string; iterations: number; keyEnvelope: { nonce: string; ciphertext: string } }): object {
    return this.auth.changePassword(body)
  }

  @Post('auth/refresh') refresh(@Body() body: { deviceId: string; refreshToken: string }): object {
    return this.auth.refresh(body.deviceId, body.refreshToken)
  }

  @Get('devices') @UseGuards(AuthGuard)
  devices(): object { return { items: this.database.listDevices() } }

  @Post('devices/revoke') @UseGuards(AuthGuard)
  revoke(@Req() req: AuthRequest, @Body() body: { deviceId: string }): object {
    if (body.deviceId === req.claims.deviceId) return { revoked: false, reason: 'cannot_revoke_current_device' }
    this.database.revokeDevice(body.deviceId)
    return { revoked: true }
  }
}
