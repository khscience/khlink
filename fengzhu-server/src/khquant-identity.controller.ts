import { Body, Controller, Get, Post } from '@nestjs/common'
import { KhQuantIdentityService } from './khquant-identity.service'

@Controller('v2/identity')
export class KhQuantIdentityController {
  constructor(private readonly identity: KhQuantIdentityService) {}

  @Get('status') status(): object { return { configured: this.identity.configured(), provider: 'khQuant', protocol: 'OAuth 2.1 + PKCE' } }

  @Post('authorization') authorization(@Body() body: { codeChallenge: string; redirectUri: string }): object {
    return this.identity.beginAuthorization(body)
  }

  @Post('callback') callback(@Body() body: { state: string; code: string; codeVerifier: string }): Promise<object> {
    return this.identity.completeAuthorization(body)
  }
}
