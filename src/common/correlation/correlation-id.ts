import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

const resolved = new WeakMap<object, string>();

/**
 * The id that follows a request from the API to the outbox, the queue and the
 * worker. A caller-supplied `x-correlation-id` is kept only if it is a UUID
 * (it is stored in CHAR(36) columns and must not be free text); otherwise a
 * new one is generated. Memoized per request, so the HTTP logger and the CLS
 * middleware agree whichever of them runs first.
 */
export function resolveCorrelationId(request: RequestLike): string {
  let id = resolved.get(request);
  if (!id) {
    const header = request.headers[CORRELATION_ID_HEADER];
    id =
      typeof header === 'string' && UUID.test(header)
        ? header.toLowerCase()
        : randomUUID();
    resolved.set(request, id);
  }
  return id;
}

/** The correlation id of the request or job being handled, if any. */
export function currentCorrelationId(): string | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive() ? cls.getId() : undefined;
}

/** Runs `fn` (and everything it awaits) under the given correlation id. */
export function runWithCorrelationId<T>(
  correlationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run(() => {
    cls.set(CLS_ID, correlationId);
    return fn();
  });
}
