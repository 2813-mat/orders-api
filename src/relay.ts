import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { OutboxRelay } from './outbox/outbox.relay';
import { RelayModule } from './relay.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(RelayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // SIGTERM (docker stop) lets the batch in flight commit before exiting.
  app.enableShutdownHooks();
  app.get(OutboxRelay).start();
}
void bootstrap();
