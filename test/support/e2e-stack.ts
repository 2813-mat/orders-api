import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { setupSwagger } from '../../src/docs/swagger';
import { OrderStatus } from '../../src/orders/domain/order-status.enum';
import { Order } from '../../src/database/entities/order.entity';
import { ORDERS_QUEUE } from '../../src/orders/queue/queue.constants';
import { OutboxEvent } from '../../src/database/entities/outbox-event.entity';
import { OutboxStatus } from '../../src/outbox/domain/outbox-status.enum';
import { OutboxRelay } from '../../src/outbox/services/outbox.relay';
import { RelayModule } from '../../src/relay.module';
import { WorkerModule } from '../../src/worker.module';
import { E2E_IDP_PORT } from './e2e-env';
import { FakeIdp } from './fake-idp';

export interface E2eStack {
  api: INestApplication<App>;
  relay: INestApplicationContext;
  worker: INestApplicationContext;
  idp: FakeIdp;
  dataSource: DataSource;
  http: () => ReturnType<typeof request>;
  /** Resolves once no order is PENDING and nothing is left to publish or process. */
  waitForIdle: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * The three real processes of the system inside the test process: the HTTP
 * API (AppModule), the outbox relay (RelayModule, polling) and the worker
 * (WorkerModule, consuming the queue), wired as main.ts, relay.ts and worker.ts
 * do, against the Testcontainers MySQL and Redis and a FakeIdp for Keycloak.
 * The environment comes from test/support/e2e-env.ts.
 */
export async function startE2eStack(): Promise<E2eStack> {
  const idp = await FakeIdp.start(E2E_IDP_PORT);

  const api = await NestFactory.create<INestApplication<App>>(AppModule, {
    logger: false,
  });
  setupSwagger(api);
  await api.init();

  const relay = await NestFactory.createApplicationContext(RelayModule, {
    logger: false,
  });
  relay.get(OutboxRelay).start();

  const worker = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });

  const dataSource = api.get<DataSource>(getDataSourceToken());
  const orders = worker.get<Queue>(getQueueToken(ORDERS_QUEUE));

  const waitForIdle = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const [pendingOrders, pendingEvents, jobs] = await Promise.all([
        dataSource
          .getRepository(Order)
          .countBy({ status: OrderStatus.PENDING }),
        dataSource
          .getRepository(OutboxEvent)
          .countBy({ status: OutboxStatus.PENDING }),
        orders.getJobCounts('active', 'waiting', 'delayed'),
      ]);
      const busyJobs = Object.values(jobs).reduce((sum, n) => sum + n, 0);
      if (pendingOrders + pendingEvents + busyJobs === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `system not idle: ${pendingOrders} PENDING orders, ${pendingEvents} outbox events, ${busyJobs} jobs`,
        );
      }
      await sleep(50);
    }
  };

  return {
    api,
    relay,
    worker,
    idp,
    dataSource,
    http: () => request(api.getHttpServer()),
    waitForIdle,
    stop: async () => {
      await relay.close();
      await worker.close();
      await api.close();
      await idp.stop();
    },
  };
}
