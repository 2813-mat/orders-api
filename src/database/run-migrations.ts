import dataSource from './data-source';

async function runMigrations(): Promise<void> {
  await dataSource.initialize();
  try {
    const executed = await dataSource.runMigrations({ transaction: 'each' });
    console.log(
      executed.length
        ? `Executed migrations: ${executed.map((m) => m.name).join(', ')}`
        : 'No pending migrations',
    );
  } finally {
    await dataSource.destroy();
  }
}

runMigrations().catch((error: unknown) => {
  console.error('Migration failed', error);
  process.exit(1);
});
