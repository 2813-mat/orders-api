import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

/**
 * An open database transaction. Services receive it from
 * {@link TransactionRunner.run} and hand it to repository methods, so every
 * write inside the callback commits or rolls back together.
 */
export type Transaction = EntityManager;

/**
 * Lets services define units of work (what must be atomic) without touching
 * TypeORM: the SQL stays in the repositories.
 */
@Injectable()
export class TransactionRunner {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Commits when `work` resolves, rolls back when it throws. */
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }
}
