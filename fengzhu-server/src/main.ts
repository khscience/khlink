import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { json } from 'express'
import { AppModule } from './app.module'
import { RelayGateway } from './relay.gateway'
import { createRateLimitMiddleware, v2RateLimitRules } from './rate-limit.middleware'
import { TrafficService } from './traffic.service'
import { createTrafficMiddleware } from './traffic.middleware'

@Controller()
class HealthController {
  @Get('healthz') health(): object {
    return { ok: true, service: 'fengzhu-agent-bridge', protocolVersion: 2, supportedProtocolVersions: [1, 2] }
  }
}
@Module({ controllers: [HealthController], imports: [AppModule] })
class RootModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(RootModule, { bodyParser: false })
  app.use(createRateLimitMiddleware(v2RateLimitRules))
  app.use(createTrafficMiddleware(app.get(TrafficService)))
  // Codex imageGeneration results are inline base64 images. A normal 1–3 MB
  // PNG becomes larger after base64 plus authenticated encryption, so the old
  // 2 MB parser limit rejected valid history syncs before the phone could
  // render them. Keep the limit bounded while allowing a few generated images.
  app.use(json({ limit: process.env.FENGZHU_JSON_LIMIT || '12mb' }))
  app.setGlobalPrefix('api', { exclude: ['healthz'] })
  app.enableCors({ origin: false })
  app.get(RelayGateway).attach(app.getHttpServer())
  await app.listen(Number(process.env.PORT || 8110), '127.0.0.1')
}
void bootstrap()
