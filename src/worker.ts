import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  // SIGTERM (docker stop) closes the BullMQ workers, which wait for the jobs
  // in progress to finish instead of leaving them to be picked up as stalled.
  app.enableShutdownHooks();
  logger.log('Worker started', 'Worker');
}
void bootstrap();
