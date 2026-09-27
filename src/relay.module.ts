import { Module } from '@nestjs/common';
import { LoggingModule } from './common/logging/logging.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OutboxRelayModule } from './outbox/outbox-relay.module';

/** Outbox relay process: MySQL in, BullMQ out, no HTTP. */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule.forRoot({ http: false }),
    DatabaseModule,
    OutboxRelayModule,
  ],
})
export class RelayModule {}
