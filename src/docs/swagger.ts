import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const DOCS_PATH = 'docs';

const DESCRIPTION = `
Orders are created as **PENDING** and processed asynchronously: the API saves
the order and an \`order.created\` event in one transaction (transactional
outbox), a relay publishes it to BullMQ and a worker reserves stock, ending in
**PROCESSED** or **FAILED**. Follow an order with \`GET /orders/{id}\`.

**Authentication**: Keycloak access token (realm \`orders\`). With the compose
stack running:

\`\`\`
curl -s -X POST http://localhost:8080/realms/orders/protocol/openid-connect/token \\
  -d grant_type=password -d client_id=orders-api -d client_secret=orders-api-secret \\
  -d username=user -d password=user123
\`\`\`

Users: \`user\` / \`user123\` (USER), \`admin\` / \`admin123\` (ADMIN + USER).
Paste the \`access_token\` in **Authorize**.
`;

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Orders API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Keycloak access token',
    })
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Swagger UI at /docs, raw OpenAPI at /docs/json. Not behind the guards. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(DOCS_PATH, app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: `${DOCS_PATH}/json`,
    swaggerOptions: { persistAuthorization: true },
  });
}
