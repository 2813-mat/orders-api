export default async function globalTeardown(): Promise<void> {
  await globalThis.__MYSQL_CONTAINER__?.stop();
}
