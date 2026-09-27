export default async function globalTeardown(): Promise<void> {
  await Promise.all([
    globalThis.__MYSQL_CONTAINER__?.stop(),
    globalThis.__REDIS_CONTAINER__?.stop(),
  ]);
}
