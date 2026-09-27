import { EntityManager } from 'typeorm';
import { Product } from '../entities/product.entity';

export const INITIAL_STOCK = 5;

export const SEED_PRODUCTS = ['Notebook', 'Mouse', 'Teclado'];

/**
 * Idempotent: existing products keep their stock, so re-running the seed
 * (every API container start) never resets stock that was already consumed.
 */
export async function seedProducts(manager: EntityManager): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(Product)
    .values(SEED_PRODUCTS.map((name) => ({ name, stock: INITIAL_STOCK })))
    // ON DUPLICATE KEY UPDATE name = name: a no-op that, unlike INSERT IGNORE,
    // doesn't hide other errors. `stock` is deliberately not in the list.
    .orUpdate(['name'])
    // Skip reloading generated ids: on a duplicate there is no insertId.
    .updateEntity(false)
    .execute();
}
