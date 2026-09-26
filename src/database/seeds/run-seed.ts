import dataSource from '../data-source';
import { seedProducts } from './products.seed';

async function runSeed(): Promise<void> {
  await dataSource.initialize();
  try {
    await seedProducts(dataSource.manager);
    console.log('Seed completed');
  } finally {
    await dataSource.destroy();
  }
}

runSeed().catch((error: unknown) => {
  console.error('Seed failed', error);
  process.exit(1);
});
