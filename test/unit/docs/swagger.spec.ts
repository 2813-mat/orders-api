import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { buildOpenApiDocument } from '../../../src/docs/swagger';
import { HealthController } from '../../../src/health/controllers/health.controller';
import { OrdersController } from '../../../src/orders/controllers/orders.controller';
import { OrdersService } from '../../../src/orders/services/orders.service';

describe('OpenAPI document', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    // Only the controllers' metadata matters: the services are never called.
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController, HealthController],
      providers: [
        { provide: OrdersService, useValue: {} },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    doc = buildOpenApiDocument(app);
  });
  afterAll(() => app.close());

  const operation = (path: string, method: 'get' | 'post') => {
    const op = doc.paths[path]?.[method];
    if (!op) {
      throw new Error(`${method.toUpperCase()} ${path} is not documented`);
    }
    return op;
  };
  const statuses = (path: string, method: 'get' | 'post') =>
    Object.keys(operation(path, method).responses).sort();
  const refOf = (path: string, method: 'get' | 'post', status: string) =>
    JSON.stringify(operation(path, method).responses[status]);

  it('documents every route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/health',
      '/orders',
      '/orders/{id}',
      '/orders/{id}/reprocess',
    ]);
  });

  it('declares bearer auth, required on orders and not on health', () => {
    expect(doc.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const [path, method] of [
      ['/orders', 'post'],
      ['/orders', 'get'],
      ['/orders/{id}', 'get'],
      ['/orders/{id}/reprocess', 'post'],
    ] as const) {
      expect(operation(path, method).security).toEqual([{ bearer: [] }]);
    }
    expect(operation('/health', 'get').security).toBeUndefined();
  });

  it('documents POST /orders: body, created order and its errors', () => {
    expect(JSON.stringify(operation('/orders', 'post').requestBody)).toContain(
      '#/components/schemas/CreateOrderDto',
    );
    expect(statuses('/orders', 'post')).toEqual([
      '201',
      '400',
      '401',
      '403',
      '422',
    ]);
    expect(refOf('/orders', 'post', '201')).toContain(
      '#/components/schemas/OrderResponse',
    );
  });

  it('documents the list as a page with page/limit query params', () => {
    expect(
      operation('/orders', 'get').parameters?.map((p) =>
        'name' in p ? p.name : undefined,
      ),
    ).toEqual(expect.arrayContaining(['page', 'limit']));
    expect(refOf('/orders', 'get', '200')).toContain(
      '#/components/schemas/OrderPage',
    );
  });

  it('documents reprocess as 202 with its 404 and 409', () => {
    expect(statuses('/orders/{id}/reprocess', 'post')).toEqual([
      '202',
      '400',
      '401',
      '403',
      '404',
      '409',
    ]);
  });

  it('exposes the order statuses and hides internal columns', () => {
    const schemas = doc.components?.schemas ?? {};
    expect(schemas.OrderStatus).toMatchObject({
      enum: ['PENDING', 'PROCESSED', 'FAILED'],
    });
    const order = schemas.OrderResponse as { properties: object };
    expect(Object.keys(order.properties)).not.toEqual(
      expect.arrayContaining(['createdBySub']),
    );
    expect(Object.keys(order.properties)).not.toContain('correlationId');
  });
});
