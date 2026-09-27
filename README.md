# Orders API

[![CI](https://github.com/2813-mat/orders-api/actions/workflows/ci.yml/badge.svg)](https://github.com/2813-mat/orders-api/actions/workflows/ci.yml)

Backend de pedidos com processamento assíncrono: **NestJS + MySQL + BullMQ (Redis) + Keycloak**.

O pedido é aceito na hora como `PENDING` e processado depois por um worker, que reserva o estoque e termina em `PROCESSED` ou `FAILED`. A reserva é **segura sob concorrência** (o estoque nunca fica negativo) e **idempotente sob retry** (um pedido nunca baixa o estoque duas vezes). Os testes com MySQL e Redis reais provam as duas coisas.

As respostas às perguntas de arquitetura estão em [RESPOSTAS.md](RESPOSTAS.md).

---

## Sumário

1. [Visão geral](#visão-geral)
2. [Como rodar](#como-rodar)
3. [Endpoints e permissões](#endpoints-e-permissões)
4. [Testes](#testes)
5. [Modelagem de dados](#modelagem-de-dados)
6. [Decisões de arquitetura](#decisões-de-arquitetura)
7. [Concorrência e idempotência no estoque](#concorrência-e-idempotência-no-estoque)
8. [Retry, falha e dead-letter](#retry-falha-e-dead-letter)
9. [Transactional Outbox](#transactional-outbox)
10. [Autenticação e SSO (Keycloak)](#autenticação-e-sso-keycloak)
11. [Observabilidade: investigando um pedido](#observabilidade-investigando-um-pedido)
12. [Ambiguidades do enunciado e decisões](#ambiguidades-do-enunciado-e-decisões)
13. [Estrutura do código](#estrutura-do-código)
14. [O que eu faria com mais tempo](#o-que-eu-faria-com-mais-tempo)

---

## Visão geral

```mermaid
flowchart LR
  C[Cliente] -- "1. login / client credentials" --> K[Keycloak]
  C -- "2. POST /orders (Bearer JWT)" --> A[API]
  A -- "valida JWT (JWKS em cache)" -.-> K
  A -- "3. 1 transação: pedido + itens + evento" --> DB[(MySQL)]
  R[Relay] -- "4. SELECT ... FOR UPDATE SKIP LOCKED" --> DB
  R -- "5. add(jobId = id do evento)" --> Q[[BullMQ: orders]]
  Q --> W[Worker]
  W -- "6. reserva estoque + PROCESSED/FAILED (1 transação)" --> DB
  W -- "falha técnica esgotada" --> D[[BullMQ: orders-dlq]]
```

São **três processos** da mesma imagem Docker, cada um com seu entrypoint:

| Processo | Entrypoint | O que faz |
|---|---|---|
| **API** | `dist/main.js` | HTTP. Valida o token, grava pedido + itens + evento `order.created` no outbox **na mesma transação** e responde `201 PENDING`. Nunca fala com o Redis. |
| **Relay** | `dist/relay.js` | Lê o outbox e publica cada evento na fila `orders` com `jobId = id do evento`. |
| **Worker** | `dist/worker.js` | Consome `orders`, simula 1–2s de trabalho, reserva o estoque numa transação e marca `PROCESSED` ou `FAILED`. Retry com backoff; esgotou → `FAILED` + fila `orders-dlq`. |

---

## Como rodar

Pré-requisito: **Docker** (com Compose v2). Nada mais precisa estar instalado para rodar a aplicação.

```bash
cp .env.example .env
docker compose up --build
```

Um único comando sobe tudo. As migrations e o seed rodam sozinhos antes da API, e o relay e o worker só sobem quando a API está saudável (migrations aplicadas).

| Serviço | Endereço | Observação |
|---|---|---|
| API | http://localhost:3000 | |
| Swagger | http://localhost:3000/docs | JSON em `/docs/json`; botão **Authorize** aceita o token |
| Health | http://localhost:3000/health | Público; 200 se o MySQL responde, 503 caso contrário |
| Keycloak | http://localhost:8080 | Console admin: `admin` / `admin` (realm `orders`) |
| MySQL | `localhost:3306` | `orders` / `orders` |
| Redis | `localhost:6379` | |

O seed cria os produtos **Notebook**, **Mouse** e **Teclado**, todos com **estoque 5**. Rodar o seed de novo nunca reseta estoque já consumido.

### Usuários de teste (realm `orders`, versionado em `keycloak/realm-export.json`)

| Usuário | Senha | Roles |
|---|---|---|
| `user` | `user123` | `USER` |
| `admin` | `admin123` | `ADMIN`, `USER` |
| service account do client `orders-api` | secret `orders-api-secret` | `USER` |

O token dura 15 minutos.

### Roteiro com `curl`

Os exemplos usam [`jq`](https://jqlang.org/) para extrair o token; sem ele, copie o `access_token` da resposta.

```bash
# Token de usuário (password grant, habilitado só para a demo)
TOKEN=$(curl -s -X POST http://localhost:8080/realms/orders/protocol/openid-connect/token \
  -d grant_type=password -d client_id=orders-api -d client_secret=orders-api-secret \
  -d username=user -d password=user123 | jq -r .access_token)

# Token de ADMIN
ADMIN=$(curl -s -X POST http://localhost:8080/realms/orders/protocol/openid-connect/token \
  -d grant_type=password -d client_id=orders-api -d client_secret=orders-api-secret \
  -d username=admin -d password=admin123 | jq -r .access_token)

# Token de máquina (client credentials / service account)
SVC=$(curl -s -X POST http://localhost:8080/realms/orders/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=orders-api -d client_secret=orders-api-secret \
  | jq -r .access_token)

# 1. Criar pedido: responde 201 com status PENDING
curl -s -X POST http://localhost:3000/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"customerName":"Maria","items":[{"productName":"Mouse","quantity":2,"price":49.9}]}'

# 2. Consultar (1–2s depois já está PROCESSED)
curl -s http://localhost:3000/orders/<id> -H "Authorization: Bearer $TOKEN"

# 3. Listar com paginação
curl -s "http://localhost:3000/orders?page=1&limit=10" -H "Authorization: Bearer $TOKEN"

# 4. Falha simulada: "fail" no nome → 3 tentativas com backoff → FAILED + DLQ
curl -s -X POST http://localhost:3000/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"customerName":"Cliente fail","items":[{"productName":"Mouse","quantity":1,"price":10}]}'

# 5. Concorrência: 5 pedidos simultâneos de 2 Teclados (estoque 5)
#    → exatamente 2 PROCESSED, 3 FAILED "estoque insuficiente: Teclado", estoque final 1
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:3000/orders \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"customerName\":\"Corrida $i\",\"items\":[{\"productName\":\"Teclado\",\"quantity\":2,\"price\":10}]}" &
done; wait

# 6. Reprocessar um pedido FAILED (só ADMIN; 409 se não estiver FAILED)
curl -s -X POST http://localhost:3000/orders/<id>/reprocess -H "Authorization: Bearer $ADMIN"
```

### Rodar fora do Docker (desenvolvimento)

Requer **Node 24.21** (`.nvmrc`; `nvm use`). Os pacotes `@nestjs/*` v12 são só ESM, e o Jest só consegue carregá-los a partir de CommonJS no Node 24.9+.

```bash
npm ci
docker compose up -d mysql redis keycloak
npm run migration:run && npm run seed
npm run start:dev                  # API
node dist/relay.js                 # relay  (depois de npm run build)
node dist/worker.js                # worker (depois de npm run build)
```

---

## Endpoints e permissões

| Endpoint | USER | ADMIN | Respostas |
|---|---|---|---|
| `POST /orders` | ✅ | ✅ | 201 · 400 validação · 401 · 403 · 422 produto inexistente ou total grande demais |
| `GET /orders?page=&limit=` | só os próprios | todos | 200 `{ data, meta: { page, limit, total, totalPages } }` · 400 |
| `GET /orders/:id` | só os próprios (**404** para o de outro) | todos | 200 · 400 id não-UUID · 404 |
| `POST /orders/:id/reprocess` | ❌ 403 | ✅ | **202** · 404 · **409** se não estiver FAILED |
| `GET /health` | público | público | 200 · 503 |

- **Token sem nenhuma das roles** → 403.
- **Header opcional `x-correlation-id`** (UUID): é propagado até o worker e sempre volta na resposta.

---

## Testes

```bash
npm test            # unitários (sem dependências)
npm run test:int    # integração: MySQL 8.4 + Redis 7 reais via Testcontainers (precisa do Docker)
npm run test:e2e    # e2e: API + relay + worker reais, via HTTP (precisa do Docker)
npm run test:all    # os três
```

**96 unitários, 125 de integração e 9 e2e.** A CI (GitHub Actions) roda lint, `tsc`, build e as três suítes a cada push. As suítes com banco usam **as mesmas migrations de produção** e não dependem do `.env`.

### O que os testes provam

**Unitários:** a lógica pura.
- Cálculo do total em centavos (`0.1 + 0.2 = 0.30`, limites do `DECIMAL(12,2)`).
- **Decisão de retry/falha** (`decideFailure`).
- Agregação e ordenação das linhas de reserva.
- Paginação e correlation id.
- Orquestração do processor com dublês (a DLQ é gravada **antes** do `FAILED`).
- Documento OpenAPI.

**Integração:** o que só um banco e uma fila reais provam.
- **Concorrência:**
  - 2 pedidos de 3 com estoque 5 → exatamente 1 confirmado, estoque final 2;
  - 10 pedidos de 1 com estoque 5 → 5/5, estoque 0.
- **Idempotência:** o mesmo pedido processado 5× em paralelo → uma baixa e uma reserva.
- **Atomicidade multi-item:** um item sem estoque → nada muda no outro.
- **Deadlock:** itens em ordem invertida, 10 rodadas → nenhum deadlock.
- **Rede de segurança do banco:** `UPDATE stock = -1` é recusado.
- **Outbox:**
  - falha ao gravar o evento → rollback do pedido;
  - **Redis inacessível** → evento continua `PENDING` e é publicado quando o Redis volta;
  - **duas instâncias do relay** sobre 100 eventos → exatamente 100 publicações.
- **Fila real:** pedido "fail" → 3 tentativas com backoff → `FAILED` + DLQ.
- **HTTP:** auth (assinatura, `iss`, `aud`, expiração, roles), validação, paginação, reprocess concorrente (um 202 e um 409).

**E2E:** os três processos juntos. O cliente só usa HTTP e acompanha o pedido até `PROCESSED`/`FAILED`, inclusive 6 pedidos simultâneos contra estoque 3.

> Para garantir que os testes de concorrência detectam o problema de verdade, removi temporariamente a condição `stock >= ?` do UPDATE: **4 testes falharam**. Sem o `FOR UPDATE` no pedido, **1 falhou**. Sem o `status = 'FAILED'` no reprocess, **3 falharam**.

No lugar do Keycloak, os testes usam um **IdP falso** (`test/support/fake-idp.ts`): um par RSA e um servidor JWKS local emitindo tokens no formato do Keycloak. O `JwtStrategy` e os guards rodam de verdade; nada do lado da API é mockado.

---

## Modelagem de dados

| Tabela | Destaques |
|---|---|
| `products` | `name` **UNIQUE** (o POST recebe o nome); `stock INT UNSIGNED` + `CHECK (stock >= 0)` |
| `orders` | PK `CHAR(36)` UUID gerado na aplicação (não enumerável). `total DECIMAL(12,2)`, `status ENUM`, `failure_reason`, `processing_attempts`, `correlation_id`, `created_by_sub` (sub do Keycloak), `DATETIME(3)`. Índices: `(created_at, id)` p/ listagem do ADMIN, `(created_by_sub, created_at)` p/ listagem do USER, `(status, created_at)` p/ operação |
| `order_items` | Snapshot de `product_name` e `unit_price`, `subtotal`. FK para `orders` (CASCADE) e `products`. `CHECK (quantity > 0)`, `CHECK (preços >= 0)` |
| `stock_reservations` | Uma linha por (pedido, produto) reservado, com **UNIQUE (order_id, product_id)** — a garantia no banco de que um pedido não reserva duas vezes |
| `outbox_events` | `id` (vira o `jobId`), `event_type`, `aggregate_id`, `payload JSON`, `status`, `attempts`, `last_error`, `published_at`. Índice `(status, created_at)` = exatamente o filtro do relay |
| `users` | Perfil local mínimo (`keycloak_sub` UNIQUE, username, email, tipo, visto em) — cache, não fonte da verdade |

- **Dinheiro:** `DECIMAL(12,2)` no banco e cálculo em **centavos inteiros** na aplicação.
- **Datas:** `DATETIME(3)` em UTC.
- **Migrations:** versionadas, com `synchronize: false`. Os CHECKs foram escritos à mão, porque o TypeORM não os gera para MySQL.

---

## Decisões de arquitetura

| Tema | Escolha | Por quê / trade-off |
|---|---|---|
| ORM | TypeORM 1.x com migrations | Integração nativa com Nest e SQL explícito onde importa (UPDATE condicional, `FOR UPDATE`, `SKIP LOCKED`) |
| Fila | BullMQ (Redis) | Retry com backoff, `attempts`, `jobId` para deduplicação e `concurrency` configurável prontos. RabbitMQ daria roteamento mais rico, mas nada aqui precisa disso |
| Publicação | **Transactional Outbox** + relay | Elimina o "pedido salvo, publicação falhou" (pedido `PENDING` órfão para sempre). Custo: um processo a mais e latência de polling (~500 ms) |
| Processos | API, relay e worker separados (mesma imagem) | Escalam e caem independentemente; a API continua aceitando pedidos com o Redis fora |
| Estoque | **UPDATE condicional atômico** numa transação | Ver [a seção de concorrência](#concorrência-e-idempotência-no-estoque) |
| Idempotência | Lock do pedido + checagem de status + UNIQUE em `stock_reservations` + `jobId` | Defesa em camadas: nenhuma depende sozinha de a fila entregar uma vez só |
| Falha | Negócio (sem estoque) ≠ técnica (erro/"fail") | Sem estoque não melhora em 2s: falha já, sem retry. Técnica: 3 tentativas com backoff exponencial, depois `FAILED` + DLQ |
| Transações | `dataSource.transaction(cb)`; **nada de I/O externo dentro** | O sleep de 1–2s fica fora da transação para não segurar lock de estoque |
| Auth | Keycloak como IdP; API só valida (resource server) | SSO real no compose; a API não guarda senha nem role |
| Resposta do POST | **201** com o pedido `PENDING` | O recurso foi criado; o processamento é que é assíncrono. 202 seria defensável, mas o cliente já recebe um recurso consultável |
| Validação | `class-validator` nos DTOs; **Zod** no env | A aplicação não sobe com env inválido (todas as variáveis são validadas de uma vez) |

---

## Concorrência e idempotência no estoque

É o ponto central do enunciado. Tudo acontece em **uma transação** (`OrderProcessingService.reserveAndConfirm`):

```sql
-- 1. Trava o pedido. Um segundo worker com o mesmo pedido espera aqui
--    e, quando entra, vê que ele já não está PENDING: não faz nada.
SELECT id, status FROM orders WHERE id = ? FOR UPDATE;

-- 2. Itens agregados por produto ("Mouse 3 + Mouse 3" = 6) e ORDENADOS por product_id.
-- 3. Para cada produto, verificação e baixa numa única instrução atômica:
UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?;
--    0 linhas afetadas = sem estoque → ROLLBACK de tudo (inclusive produtos já baixados)
INSERT INTO stock_reservations (order_id, product_id, quantity) VALUES (?, ?, ?);

-- 4.
UPDATE orders SET status = 'PROCESSED', processed_at = NOW(3) WHERE id = ?;
COMMIT;
```

Depois de um rollback por falta de estoque, o pedido é marcado `FAILED` com `"estoque insuficiente: <produto>"`. Isso acontece numa transação separada, com `WHERE status = 'PENDING'`, para nunca sobrescrever um estado final.

### Por que UPDATE condicional, e não lock otimista ou pessimista no produto?

- **UPDATE condicional (escolhido):** a verificação e a baixa são **uma única instrução**. Não existe janela entre "li o estoque" e "gravei". O MySQL serializa os UPDATEs na mesma linha, e o segundo reavalia `stock >= ?` com o valor já atualizado. O lock dura só o UPDATE, e dois pedidos disputando o último item nunca geram erro: um afeta 1 linha, o outro 0.
- **`SELECT ... FOR UPDATE` no produto (pessimista):** também correto, mas são duas idas ao banco segurando o lock entre elas. Não traz vantagem aqui.
- **Versão (otimista):** sob disputa de um produto popular vira uma tempestade de conflitos e retries. Serve quando conflito é raro, e aqui ele é o cenário do teste.

### O que protege cada cenário

| Cenário | Proteção |
|---|---|
| 2 pedidos disputando o último estoque | UPDATE condicional atômico |
| Mesmo job entregue 2× (stalled job, crash depois do commit) | `FOR UPDATE` no pedido + status ≠ `PENDING` ⇒ não faz nada |
| Mesmo evento republicado pelo relay | `jobId = id do evento` (o BullMQ deduplica) |
| Bug que pule a checagem de status | `UNIQUE (order_id, product_id)` em `stock_reservations` |
| Estoque negativo por qualquer caminho | `INT UNSIGNED` + `CHECK (stock >= 0)` |
| Pedido com item OK + item sem estoque | Rollback da transação inteira (sem compensação manual) |
| Deadlock entre pedidos com vários itens | Linhas travadas sempre na ordem de `product_id` |
| Reprocessamento manual | Só pedido `FAILED`, que por construção nunca tem reserva |

---

## Retry, falha e dead-letter

A decisão fica numa função pura, `decideFailure(error, attempt, maxAttempts)`, em `src/orders/domain/failure-policy.ts`:

| Erro | Decisão |
|---|---|
| `InsufficientStockError` (negócio) | `FAILED` já, **sem retry e sem DLQ** (job concluído) |
| Técnico ou simulado, tentativa < máximo | **retry** (o BullMQ reagenda com backoff exponencial: 1s, 2s…) |
| Técnico ou simulado na última tentativa | `FAILED` com o motivo + cópia na fila **`orders-dlq`** |
| Qualquer coisa que nem seja `Error` | Tratado como técnico |

**Detalhes:**
- **"fail" no nome** (sem diferenciar maiúsculas) lança um erro simulado depois do trabalho de 1–2s e **antes** da reserva: nenhum estoque é tocado.
- **`processing_attempts`** conta as tentativas no próprio pedido.
- **Ordem na falha definitiva:** a DLQ é gravada **antes** do `FAILED`, com `jobId = <orderId>-<jobId>`. Se o worker cair entre os dois passos, a repetição encontra o pedido ainda `PENDING` e a DLQ não duplica.
- **Para que serve a DLQ:** análise. O caminho de replay é o `POST /orders/:id/reprocess`, que volta o pedido para `PENDING` e grava um novo evento no outbox, tudo numa transação. Duas chamadas simultâneas reenfileiram uma vez só.

Configuração (`.env`): `QUEUE_ATTEMPTS=3`, `QUEUE_BACKOFF_MS=1000`, `WORKER_CONCURRENCY=5`, `PROCESSING_MIN_MS`/`MAX_MS`.

---

## Transactional Outbox

**Por que existe:** sem ele, o `POST` faria "grava no MySQL" e depois "publica no Redis", duas operações sem atomicidade. Se o Redis cai entre as duas, o pedido fica `PENDING` para sempre, sem evento. Com o outbox, o pedido, os itens e o evento são gravados **na mesma transação**. Se o evento existe, o pedido existe, e vice-versa. **Com o Redis fora, o `POST` continua respondendo 201.**

**Relay** (`src/outbox/outbox.relay.ts`), a cada `OUTBOX_POLL_INTERVAL_MS`:
- **Lote:** `SELECT … WHERE status='PENDING' ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED`. Várias instâncias podem rodar lado a lado sem pegar o mesmo evento.
- **Publicação e confirmação:** `queue.add(event_type, payload, { jobId: event.id })`, depois `PUBLISHED`. Tudo numa transação curta.
- **Timeout na publicação:** `OUTBOX_PUBLISH_TIMEOUT_MS`. Com o Redis fora, o BullMQ **espera para sempre** em vez de falhar, e isso seguraria a transação e os locks.
- **Falha:** `attempts+1` e `last_error`, e o lote **para no primeiro erro**. Com o Redis fora, tentar os próximos só gastaria as tentativas deles. O intervalo cresce exponencialmente até 30s. Depois de `OUTBOX_MAX_ATTEMPTS`, o evento vira `FAILED`.
- **Backlog:** a cada 30s o relay registra o log `outbox.backlog`, com `pending`, `failed` e a idade do evento pendente mais antigo. É `warn` se o mais antigo passar de 60s.

**Limites, reconhecidos:**
- A entrega é **at-least-once**. Se o relay publicar e cair antes do commit, o evento é publicado de novo. O `jobId` deduplica enquanto o job existir no Redis, e o consumidor idempotente cobre o resto. **O outbox não dispensa um consumidor idempotente.**
- O polling adiciona latência e carga leve no banco. CDC (Debezium lendo o binlog) resolveria as duas coisas, com mais infraestrutura.

---

## Autenticação e SSO (Keycloak)

O Keycloak roda no compose com o realm **importado de um arquivo versionado**: roles, client, usuários e service account, com ids fixos. Ninguém precisa clicar em nada.

**A API é um resource server.** Ela não emite tokens nem guarda senha ou role; só valida o JWT (`src/auth/`):
- **Assinatura:** RS256 com as chaves públicas do **JWKS**, em cache (`jwks-rsa`, cache de 10 min e rate limit). Só RS256 é aceito, o que bloqueia `alg: none` e confusão com HS256.
- **Claims:** `iss` e `aud` (`orders-api`) conferidos, e o token precisa ter `sub`.
- **Roles:** vêm de `realm_access.roles`. Só `ADMIN` e `USER` são reconhecidas; as demais são descartadas.
- **Service account:** identificada pelo prefixo `service-account-` do `preferred_username`. O token do Keycloak 26.7 não traz `client_id`.
- **Guards globais**, nessa ordem: `JwtAuthGuard` (401) e `RolesGuard` (403). Tudo é protegido por padrão; `@Public()` libera explicitamente (só o `/health`).

**Armadilha do issuer, resolvida:**
- O token precisa ter o mesmo `iss` quando é pedido do host (`localhost:8080`) e de dentro da rede Docker (`keycloak:8080`).
- `KC_HOSTNAME=http://localhost:8080` fixa o issuer público, e `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` deixa a API buscar o JWKS pelo endereço interno.
- Por isso existem duas variáveis: `KEYCLOAK_ISSUER` (a URL pública) e `KEYCLOAK_JWKS_URI` (a URL interna).

**Usuários locais: por que não replicar.**
- **Fonte da verdade:** o Keycloak. Replicar usuários e roles no MySQL criaria dois donos do mesmo dado, com sincronização de criação, alteração e exclusão e risco de divergência.
- **O que a API guarda:** o `sub` em cada pedido (`created_by_sub`) e um **perfil local mínimo** na tabela `users`, gravado sob demanda no primeiro request de cada usuário (upsert, no máximo uma vez a cada 5 min por usuário). Uma falha nesse upsert nunca derruba o request.
- **Sincronização completa** só se justificaria com necessidade real (relatórios com join, dados de domínio ligados ao usuário). Seria feita por eventos do Keycloak, não por polling.

---

## Observabilidade: investigando um pedido

**Logs:**
- **Formato:** JSON estruturado (pino). Em terminal interativo saem legíveis; no Docker, em JSON.
- **`correlationId` em toda linha:** ele vem do header `x-correlation-id` (só se for UUID) ou é gerado. É gravado no pedido e no evento do outbox, viaja no payload do job, e o worker processa cada job dentro do contexto desse id. A API, o relay e o worker logam **com o mesmo id**.
- **Segurança:** `authorization` e `cookie` são removidos dos logs.

**Eventos de log nomeados:**

| Processo | Eventos |
|---|---|
| API | `order.created` |
| Relay | `order.enqueued`, `outbox.backlog` |
| Worker | `order.processing.started`, `.completed` (com `durationMs`), `.retry` (com `attempt` e `delayMs`), `.failed`, `.skipped`, `order.stock.insufficient` |

### "Um cliente reclama que o pedido X ficou PENDING por 10 minutos"

**1. O pedido e o evento dele no banco.** A resposta já separa os casos:

```sql
SELECT status, correlation_id, processing_attempts, created_at FROM orders WHERE id = 'X';
SELECT id, status, attempts, last_error, published_at FROM outbox_events WHERE aggregate_id = 'X';
```

| O que aparece | Onde está o problema |
|---|---|
| Nenhuma linha no outbox | **Na API** (bug na criação). Não deveria acontecer: o evento é gravado na mesma transação do pedido |
| Evento `PENDING` com `attempts` subindo e `last_error` | **Na publicação**: o Redis está fora ou inacessível. O relay tenta de novo sozinho e publica quando o Redis voltar |
| Evento `PENDING` com `attempts = 0` | **No relay**: está parado. Confirmar com o log `outbox.backlog`, que reclama quando o mais antigo passa de 60s |
| Evento `PUBLISHED` e pedido ainda `PENDING` | **Na fila ou no worker**: seguir para o passo 2 |

**2. Os logs pelo `correlationId`, nos três processos de uma vez:**

```bash
docker compose logs --no-log-prefix api relay worker | grep <correlation_id>
```

| O que aparece nos logs | Diagnóstico |
|---|---|
| Sem `order.enqueued` | O evento não saiu do outbox (voltar ao passo 1) |
| `order.enqueued`, mas sem `order.processing.started` | O job está parado na fila: **worker fora do ar ou saturado** |
| `processing.started` seguido de vários `processing.retry` | Erro recorrente no worker. A mensagem de erro está no próprio log |
| `processing.started` sem `completed` | O worker caiu no meio. O BullMQ reentrega o job (stalled), e ele é reprocessado sem baixa dupla |

**3. O job no Redis**, cujo id é o `id` do evento no outbox:

```bash
docker compose exec redis redis-cli HGETALL bull:orders:<outbox_event_id>   # attemptsMade, failedReason, stacktrace
docker compose exec redis redis-cli LLEN bull:orders:wait                   # fila crescendo = worker não dá conta
```

**4. Correção:**
- Resolvida a causa (Redis de volta, worker escalado), o fluxo retoma sozinho: o outbox e a fila guardam o trabalho.
- Um pedido que acabou `FAILED` volta com `POST /orders/:id/reprocess`.

---

## Ambiguidades do enunciado e decisões

1. **O POST recebe `productName`, não `productId`.** A tabela `products` tem `name` UNIQUE e a busca não diferencia maiúsculas. Produto inexistente é recusado **no POST com 422**: é validação de catálogo, não de estoque. O estoque continua sendo verificado **só** no worker, como pede o enunciado.
2. **`price` vem do cliente.** Foi aceito como o enunciado pede. O total é calculado pela API, nunca recebido. Em produção, o preço viria do catálogo.
3. **Produto repetido em `items`.** O pedido é gravado como enviado (duas linhas), mas a reserva **soma por produto**, para checar "3 + 3 contra 5" de uma vez.
4. **"DLQ ou FAILED".** Os dois: o pedido vira `FAILED` com o motivo e o job é copiado para `orders-dlq`.
5. **Falha de negócio x técnica.** Estoque insuficiente não tem retry; a exceção simulada tem.
6. **Pedido de outro usuário.** Responde **404**, e não 403, para não revelar que o id existe.
7. **Reprocessamento.** **202 Accepted**; só pedidos `FAILED`; qualquer outro status → 409.

---

## Estrutura do código

```
src/
├── main.ts · relay.ts · worker.ts        # os três entrypoints
├── app.module.ts · relay.module.ts · worker.module.ts
├── auth/          # JwtStrategy (JWKS), guards globais, @Roles, @Public, @CurrentUser
├── users/         # perfil local just-in-time a partir do token
├── orders/
│   ├── domain/    # funções puras: total, política de falha, linhas de reserva, erros, evento
│   ├── dto/       # entrada (class-validator) e saída (documentada no Swagger)
│   ├── entities/  # Order, OrderItem, StockReservation
│   ├── processing/# worker: processor BullMQ + reserva transacional
│   ├── queue/     # filas orders e orders-dlq
│   └── orders.controller.ts · orders.service.ts
├── outbox/        # writer transacional + relay
├── products/ · health/ · docs/ (Swagger)
├── common/        # correlation id, logging, paginação, validação, erros
├── config/        # validação do env (Zod)
└── database/      # data source, migrations, seed
test/
├── unit/ · integration/ · e2e/
└── support/       # fake IdP, Testcontainers, stack e2e
```

---

## O que eu faria com mais tempo

- **CDC (Debezium) no lugar do polling do outbox:** menos latência e menos carga no banco.
- **Cache do JWKS que sobreviva a um Keycloak fora do ar:** servir a última chave conhecida quando a busca falha, e compartilhar esse cache entre instâncias. Hoje, uma instância reiniciada com o Keycloak fora não valida tokens (detalhes em [RESPOSTAS.md](RESPOSTAS.md#4-se-o-provedor-de-sso-ficar-indisponível-como-isso-afeta-sua-api-e-o-que-você-faria-para-mitigar)).
- **Keycloak em modo produção:** `start` em vez de `start-dev`, HTTPS, banco próprio, sem password grant, alta disponibilidade.
- **Preço vindo do catálogo**, e não do cliente.
- **OpenTelemetry com tracing distribuído** (API → relay → worker) e **métricas Prometheus**: profundidade da fila, latência de ponta a ponta, taxa de falha e idade do outbox, com alertas.
- **Contrato versionado do evento** (schema registry ou pelo menos `version` no payload), para evoluir o consumidor sem quebrar.
- **Reservas com expiração** e liberação de estoque em cancelamento: hoje o estoque só desce.
- **Paginação por cursor** (`created_at, id`) no lugar de `OFFSET` para listas grandes. O índice já está pronto.
- **Rate limiting** no `POST /orders` e **testes de carga** (k6) para medir o teto do worker e do MySQL.
- **Bull Board** (ou similar) protegido por role, para inspecionar filas e DLQ sem `redis-cli`.
