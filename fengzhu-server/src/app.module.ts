import { Module } from '@nestjs/common'
import { AdminController } from './admin.controller'
import { AdminGuard } from './admin.guard'
import { DownloadMetricsService } from './download-metrics.service'
import { AuthController } from './auth.controller'
import { BillingController } from './billing.controller'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { DatabaseService } from './database.service'
import { EntitlementService } from './entitlement.service'
import { TrafficService } from './traffic.service'
import { EventController } from './event.controller'
import { HistoryController } from './history.controller'
import { KhQuantIdentityController } from './khquant-identity.controller'
import { KhQuantIdentityService } from './khquant-identity.service'
import { PairingController } from './pairing.controller'
import { PairingService } from './pairing.service'
import { RelayGateway } from './relay.gateway'
import { V2AuthGuard, V2WriteGuard } from './v2-auth.guard'
import { V2AuthService } from './v2-auth.service'
import { V2EventController } from './v2-event.controller'
import { V2HistoryController } from './v2-history.controller'
import { V2SessionController } from './v2-session.controller'

@Module({
  controllers: [AdminController, AuthController, EventController, HistoryController, KhQuantIdentityController, V2SessionController, PairingController, BillingController, V2EventController, V2HistoryController],
  providers: [DatabaseService, DownloadMetricsService, AdminGuard, AuthService, AuthGuard, RelayGateway, KhQuantIdentityService, EntitlementService, TrafficService, V2AuthService, V2AuthGuard, V2WriteGuard, PairingService],
})
export class AppModule {}
