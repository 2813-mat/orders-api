import { NestFactory } from '@nestjs/core';
import { OutboxRelay } from './outbox/outbox.relay';
import { RelayModule } from './relay.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(RelayModule);
  // SIGTERM (docker stop) lets the batch in flight commit before exiting.
  app.enableShutdownHooks();
  app.get(OutboxRelay).start();
}
void bootstrap();
