import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Order } from '../orders/entities/order.entity';
import { StockReservation } from '../orders/entities/stock-reservation.entity';
import { OutboxEvent } from '../outbox/outbox-event.entity';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';

export const ENTITIES = [
  Product,
  Order,
  OrderItem,
  StockReservation,
  OutboxEvent,
  User,
];

export type DatabaseEnv = Pick<
  EnvironmentVariables,
  'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'
>;

// .ts under ts-node (CLI), .js in dist; never pick up the emitted .d.ts files.
const migrationsExt = __filename.endsWith('.ts') ? 'ts' : 'js';

export function buildTypeOrmOptions(env: DatabaseEnv): DataSourceOptions {
  return {
    type: 'mysql',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    entities: ENTITIES,
    migrations: [join(__dirname, 'migrations', `*.${migrationsExt}`)],
    synchronize: false,
    timezone: 'Z',
  };
}
