import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ORDERS_DEAD_LETTER_QUEUE, ORDERS_QUEUE } from './queue.constants';

/**
 * Without an 'error' listener BullMQ dumps every Redis reconnection failure
 * as a raw stack trace; route them through the app logger instead.
 */
@Injectable()
export class QueueErrorLogger implements OnModuleInit {
  private readonly logger = new Logger('Queue');

  constructor(
    @InjectQueue(ORDERS_QUEUE) private readonly orders: Queue,
    @InjectQueue(ORDERS_DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {}

  onModuleInit(): void {
    for (const queue of [this.orders, this.deadLetter]) {
      queue.on('error', (error) =>
        this.logger.warn(`${queue.name}: ${error.message}`),
      );
    }
  }
}
