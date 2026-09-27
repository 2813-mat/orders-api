# Perguntas de arquitetura e sistemas

As respostas se apoiam no que foi implementado neste repositório. Onde há código ou teste que demonstra o ponto, ele está citado. Detalhes de implementação estão no [README](README.md).

---

## 1. Como você garantiria que um evento não seja processado duas vezes pelo consumidor em caso de reentrega da fila?

**Premissa:** entrega *exactly-once* não existe na prática. Qualquer fila real entrega **at-least-once**: o worker pode cair depois de gravar e antes de confirmar o job, um job pode ser considerado travado e reentregue, e o relay pode publicar de novo. O que dá para garantir é que **o efeito aconteça uma vez só**, mesmo que a mensagem chegue várias vezes. Ou seja, o consumidor tem que ser **idempotente**.

Neste projeto, em camadas, cada uma cobrindo uma falha diferente:

1. **Dedupe na publicação:** `jobId = id do evento no outbox`. O BullMQ ignora um segundo `add` com o mesmo id, então o relay publicar de novo depois de um crash não gera um job novo.
   - Limite: isso só vale enquanto o job existe no Redis, que remove os concluídos depois de um tempo. Por isso a próxima camada é a que importa.
2. **Idempotência no consumidor, dentro da mesma transação do efeito:**
   - o worker faz `SELECT … FOR UPDATE` no pedido e só segue se ele ainda estiver `PENDING`;
   - a baixa de estoque, as reservas e a mudança para `PROCESSED` acontecem **na mesma transação** desse lock.

   Dois workers com o mesmo pedido se serializam no lock, e o segundo encontra um estado final e não faz nada. Checar o status fora da transação não bastaria: haveria uma janela entre a leitura e a escrita.
3. **Restrição no banco como última defesa:** `UNIQUE (order_id, product_id)` em `stock_reservations`. Mesmo que um bug pule a checagem de status, a segunda reserva viola a constraint e a transação inteira faz rollback, inclusive a baixa de estoque.
4. **Estados finais não são sobrescritos:** marcar `FAILED` usa `WHERE status = 'PENDING'`, então um retry atrasado não desfaz um `PROCESSED`.

**Teste:** `test/integration/orders/processing/order-processing.int-spec.ts` processa o mesmo pedido 5 vezes **em paralelo** e confirma uma baixa e uma linha de reserva. Removendo o `FOR UPDATE`, o teste falha.

**Para um consumidor genérico**, sem um agregado com status para travar, o padrão é uma tabela `processed_events (event_id PRIMARY KEY)` inserida **na mesma transação** do efeito. Se o insert der chave duplicada, o evento já foi processado: a transação faz rollback e o job é confirmado sem efeito. O mesmo raciocínio vale para chamadas externas, passando uma *idempotency key* derivada do id do evento.

---

## 2. Como você escalaria o worker de consumo de eventos se o volume de pedidos multiplicasse por 10x?

**Primeiro, medir.** Escalar o worker só adianta se o gargalo for ele. As métricas que decidem:
- profundidade da fila (`waiting`);
- tempo entre `order.enqueued` e `order.processing.started` nos logs;
- idade do outbox (log `outbox.backlog`);
- latência do MySQL.

**O worker é stateless, então escala horizontalmente:**
- **Mais réplicas:** `docker compose up --scale worker=N`, ou réplicas no Kubernetes. Todas consomem a mesma fila, e a idempotência da resposta 1 torna seguro qualquer job cair em qualquer réplica.
- **Mais concorrência por réplica:** `WORKER_CONCURRENCY`. O trabalho simulado é espera de I/O (1–2s), então cada processo aguenta muito mais que 5 jobs simultâneos antes de saturar a CPU.
  - Hoje: cerca de 5 / 1,5s ≈ 3 pedidos/s por réplica.
  - 10× dá para atingir combinando as duas coisas.
- **Autoscaling pela profundidade da fila,** e não por CPU (por exemplo KEDA com scaler de Redis/BullMQ). Fila crescendo é o sinal certo para um worker que passa a maior parte do tempo esperando.

**O gargalo seguinte provavelmente é o MySQL:**
- **Conexões:** cada réplica tem seu pool. Réplicas × pool precisa caber em `max_connections`. Resolve com pool dimensionado e, se preciso, um proxy (ProxySQL).
- **Linhas quentes:** dois pedidos do mesmo produto se serializam no UPDATE daquela linha, e isso é o que garante não vender além do estoque. Como a transação é curta (o sleep fica fora dela), isso aguenta bem. Se um único produto concentrar tráfego extremo, a saída é dividir o estoque desse produto em N linhas ("baldes"), ou reservar num contador atômico no Redis e reconciliar no banco. Os dois trocam simplicidade por throughput.
- **Leituras:** `GET /orders` pode ir para réplicas de leitura.

**E o resto do pipeline:**
- **Relay:** pode ter várias instâncias (o `SKIP LOCKED` já permite), `OUTBOX_BATCH_SIZE` maior e limpeza periódica dos eventos `PUBLISHED`, para a tabela não crescer sem fim.
- **Redis:** uma instância aguenta muito mais que 10× desse volume; o que merece atenção é a memória dos jobs retidos.
- **Ordenação por chave:** se passar a importar, particionar em várias filas pela chave (por exemplo, por produto).

---

## 3. Como você faria uma migração de schema neste banco em produção, sem downtime?

**Princípio:** durante um deploy, a versão antiga e a nova do código rodam ao mesmo tempo, e isso vale para a API, o relay e o worker. Toda migration precisa ser **compatível com as duas versões**. Na prática, isso é o padrão **expand/contract**, em deploys separados:

1. **Expand:** adicionar sem quebrar nada. Coluna nova `NULL` ou com default, tabela nova, índice novo. O código antigo ignora o que não conhece.
2. **Deploy do código que escreve nos dois formatos** (antigo e novo) e ainda lê do antigo.
3. **Backfill em lotes pequenos** (por faixa de id, com pausa entre lotes), nunca um `UPDATE` único na tabela inteira, que seguraria locks e aumentaria o atraso da réplica.
4. **Deploy do código que lê do novo formato.**
5. **Contract:** remover a coluna ou o formato antigo, num deploy posterior, só depois que nenhuma versão em produção depende dele. É o único passo destrutivo e fica isolado.

**No MySQL 8, especificamente:**
- Muitas mudanças são **online**: `ALGORITHM=INSTANT` para adicionar coluna, ou acrescentar um valor **no fim** de um `ENUM` (útil para um novo status de pedido), e `ALGORITHM=INPLACE, LOCK=NONE` para criar índice. Declarar o algoritmo explicitamente faz a migration **falhar** em vez de travar a tabela silenciosamente.
- Para tabelas grandes ou mudanças que o MySQL faz copiando a tabela, `gh-ost` ou `pt-online-schema-change`: tabela sombra, cópia em background e troca atômica.
- `lock_wait_timeout` baixo na sessão da migration, para ela desistir em vez de enfileirar todas as queries atrás de um lock de metadados.

**Neste projeto:**
- **Onde as migrations rodam:** hoje no container da API, antes de ela subir, o que é suficiente com uma instância. Em produção, seriam um passo separado do pipeline (por exemplo, um Job no Kubernetes), executado antes do rollout.
- **O evento também é contrato:** o payload do job é o `{ orderId, correlationId }`. Mudá-lo segue a mesma regra: o consumidor aceita o formato antigo e o novo até que não haja mais jobs antigos na fila.

---

## 4. Se o provedor de SSO ficar indisponível, como isso afeta sua API, e o que você faria para mitigar?

**Como a API valida hoje:** localmente, com a chave pública do Keycloak. O JWKS é buscado uma vez e fica **em cache em memória por 10 minutos** (`jwks-rsa`, em `src/auth/jwt.strategy.ts`). Não há chamada ao Keycloak por request.

**O que acontece com o Keycloak fora**, verificado derrubando o container com a stack rodando:

| Situação | Resultado |
|---|---|
| Token já emitido, API com a chave em cache | **200**: continua funcionando |
| Obter um token novo (login, `client_credentials`, refresh) | **Falha**: isso depende do Keycloak |
| Instância da API **reiniciada** ou **nova** (cache vazio) | **401 para todos**: não há como buscar a chave |
| Cache de 10 min expira com o Keycloak ainda fora | **401**: o `jwks-rsa` não serve chave vencida |

**Impacto, em ordem de tempo:**
- Primeiro: logins e renovações param, e integrações por service account não conseguem token.
- Em até 15 min (a duração do token): todos os tokens expiram e os usuários ficam de fora.
- Antes disso, qualquer réplica que reinicie ou escale já nasce sem conseguir validar.

O `/health` **não** depende do Keycloak, de propósito. Uma queda do SSO não deve tirar a API de rotação e piorar o cenário.

**Mitigações, da mais barata para a mais cara:**
1. **Cache que usa a última chave conhecida quando a busca falha:** manter as chaves até conseguir renová-las, em vez de descartá-las no fim do tempo de cache. Chave de assinatura muda raramente, e servir a última conhecida durante uma queda é seguro. O `jwks-rsa` 4 já faz isso com a opção `cacheMaxAgeFallback`, que ainda não está ligada neste projeto: é a primeira mudança que eu faria.
2. **Cache compartilhado ou persistido** (por exemplo no Redis), e carregar o JWKS no boot: instâncias novas nascem com a chave mesmo com o Keycloak fora.
3. **Alta disponibilidade do Keycloak:** cluster com banco replicado, que é o que resolve de fato logins e renovações.
4. **Duração do token como decisão consciente:** tokens mais longos aguentam quedas maiores, mas uma revogação demora mais a valer (a validação local não vê revogações). 15 min com refresh é um meio-termo razoável.
5. **Observabilidade:** alerta quando a busca do JWKS falha e quando a taxa de 401 sobe de repente, que é o sintoma visível de um problema de SSO.

---

## 5. Dado um pedido que ficou "travado" sem confirmação, como você investigaria se o problema está na API, na fila ou no worker?

O desenho deixa um rastro em cada etapa. O caminho é seguir o pedido por esse rastro. O passo a passo com os comandos está no [README, seção "Observabilidade"](README.md#observabilidade-investigando-um-pedido). Em resumo:

**1. Banco: o evento do pedido no outbox.** Isso já separa os casos:

| O que aparece | Onde está o problema |
|---|---|
| Nenhum evento para o pedido | **API**: falha na criação. Pelo desenho não deveria acontecer, porque o pedido e o evento são gravados na mesma transação |
| Evento `PENDING` com `attempts` e `last_error` | **Publicação**: o Redis está fora. O relay tenta de novo sozinho |
| Evento `PENDING` sem tentativas | **Relay** parado |
| Evento `PUBLISHED` | O problema está **depois** da fila: seguir para o passo 2 |

**2. Logs, pelo `correlation_id` do pedido.** O mesmo id aparece na API, no relay e no worker:

| Último evento de log encontrado | Diagnóstico |
|---|---|
| `order.created`, sem `order.enqueued` | Não saiu do outbox (volta ao passo 1) |
| `order.enqueued`, sem `order.processing.started` | **Fila**: o job está esperando e ninguém consome. Worker fora do ar ou saturado |
| `processing.started` + vários `processing.retry` | **Worker**: erro recorrente, com a mensagem no próprio log |
| `processing.started`, sem desfecho | O worker caiu no meio. O BullMQ reentrega o job travado, e a idempotência evita baixa dupla |

**3. Redis.** O job cujo id é o id do evento (`attemptsMade`, `failedReason`, `stacktrace`) e o tamanho das filas de espera e de adiados. Fila crescendo com workers vivos significa capacidade insuficiente (ver resposta 2).

**Sinais agregados, para não depender de reclamação de cliente:**
- log `outbox.backlog` com o evento pendente mais antigo passando de 60s (problema **antes** da fila);
- profundidade da fila crescendo (problema **na fila ou no worker**);
- `/health` da API (problema **na API ou no banco**).

Numa evolução, métricas e alertas sobre esses três sinais, mais tracing distribuído (OpenTelemetry) ligando os spans da API, do relay e do worker pelo mesmo contexto, reduzem a investigação a abrir um trace.
