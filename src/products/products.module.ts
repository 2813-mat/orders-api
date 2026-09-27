import { Module } from '@nestjs/common';
import { ProductsRepository } from './repositories/products.repository';

/** Owner of the `products` table (catalog and stock). */
@Module({
  providers: [ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}
