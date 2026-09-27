import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM (docker stop) closes the BullMQ workers, which wait for the jobs
  // in progress to finish instead of leaving them to be picked up as stalled.
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker started');
}
void bootstrap();
