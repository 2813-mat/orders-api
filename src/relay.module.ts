import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OutboxRelayModule } from './outbox/outbox-relay.module';

/** Outbox relay process: MySQL in, BullMQ out, no HTTP. */
@Module({
  imports: [AppConfigModule, DatabaseModule, OutboxRelayModule],
})
export class RelayModule {}
