import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Product } from '../../database/entities/product.entity';
import { Transaction } from '../../database/transaction-runner';

@Injectable()
export class ProductsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Matched by MySQL's case-insensitive collation. */
  findByNames(names: string[]): Promise<Product[]> {
    return this.dataSource
      .getRepository(Product)
      .findBy({ name: In([...new Set(names)]) });
  }

  /**
   * Check and decrement in one statement: `WHERE stock >= quantity` is
   * evaluated against the current row under its lock, so concurrent callers
   * can never take stock below zero. Returns false when there wasn't enough.
   */
  async decrementStockIfAvailable(
    tx: Transaction,
    productId: number,
    quantity: number,
  ): Promise<boolean> {
    const result = await tx
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :productId AND stock >= :quantity', { productId, quantity })
      .setParameters({ quantity })
      .execute();
    return result.affected === 1;
  }
}
