import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Role } from '../../../../src/auth/role.enum';
import { buildTypeOrmOptions } from '../../../../src/database/typeorm.options';
import { seedProducts } from '../../../../src/database/seeds/products.seed';
import { OrderItem } from '../../../../src/database/entities/order-item.entity';
import { Order } from '../../../../src/database/entities/order.entity';
import { OrdersModule } from '../../../../src/orders/orders.module';
import { OrdersService } from '../../../../src/orders/services/orders.service';
import { OutboxEvent } from '../../../../src/database/entities/outbox-event.entity';
import { OutboxWriter } from '../../../../src/outbox/services/outbox.writer';
import { UserType } from '../../../../src/users/domain/user-type.enum';
import { testDatabaseEnv, truncate } from '../../../support/database';

describe('OrdersService.create atomicity (real MySQL)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OrdersModule,
      ],
    })
      // Fails after the order and its items were already written.
      .overrideProvider(OutboxWriter)
      .useValue({
        write: () => Promise.reject(new Error('outbox write failed')),
      })
      .compile();
    dataSource = moduleRef.get<DataSource>(getDataSourceToken());

    await truncate(dataSource, 'products');
    await seedProducts(dataSource.manager);
  });
  afterAll(() => moduleRef.close());
  beforeEach(() =>
    truncate(dataSource, 'orders', 'order_items', 'outbox_events'),
  );

  it('rolls back the order and its items when the outbox write fails', async () => {
    await expect(
      moduleRef.get(OrdersService).create(
        {
          customerName: 'Maria',
          items: [
            { productName: 'Notebook', quantity: 1, price: 10 },
            { productName: 'Mouse', quantity: 1, price: 10 },
          ],
        },
        {
          sub: randomUUID(),
          username: 'user',
          email: null,
          roles: [Role.USER],
          type: UserType.USER,
        },
      ),
    ).rejects.toThrow('outbox write failed');

    expect(await dataSource.getRepository(Order).count()).toBe(0);
    expect(await dataSource.getRepository(OrderItem).count()).toBe(0);
    expect(await dataSource.getRepository(OutboxEvent).count()).toBe(0);
  });
});
