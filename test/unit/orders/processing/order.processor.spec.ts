import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { currentCorrelationId } from '../../../../src/common/correlation/correlation-id';
import { EnvironmentVariables } from '../../../../src/config/env.validation';
import {
  InsufficientStockError,
  SimulatedProcessingError,
} from '../../../../src/orders/domain/errors';
import { OrderStatus } from '../../../../src/orders/domain/order-status.enum';
import {
  OrderProcessingService,
  ReservationOutcome,
} from '../../../../src/orders/processing/order-processing.service';
import { OrderProcessor } from '../../../../src/orders/processing/order.processor';
import {
  OrderDeadLetterData,
  OrderJobData,
} from '../../../../src/orders/queue/queue.constants';

describe('OrderProcessor (orchestration)', () => {
  const orderId = 'order-1';

  let processing: jest.Mocked<
    Pick<
      OrderProcessingService,
      'findForProcessing' | 'recordAttempt' | 'reserveAndConfirm' | 'markFailed'
    >
  >;
  let deadLetter: { add: jest.Mock };
  let processor: OrderProcessor;

  const givenOrder = (customerName: string, status = OrderStatus.PENDING) =>
    processing.findForProcessing.mockResolvedValue({
      id: orderId,
      customerName,
      status,
    });

  const aJob = (attemptsMade: number, attempts = 3) =>
    ({
      id: 'event-1',
      data: { orderId, correlationId: 'corr-1' },
      attemptsMade,
      opts: { attempts },
    }) as Job<OrderJobData>;

  beforeEach(() => {
    processing = {
      findForProcessing: jest.fn(),
      recordAttempt: jest.fn().mockResolvedValue(undefined),
      reserveAndConfirm: jest
        .fn()
        .mockResolvedValue(ReservationOutcome.PROCESSED),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    deadLetter = { add: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn().mockReturnValue(0), // no simulated delay
    } as unknown as ConfigService<EnvironmentVariables, true>;

    processor = new OrderProcessor(
      processing as unknown as OrderProcessingService,
      config,
      deadLetter as unknown as Queue<OrderDeadLetterData>,
    );
  });

  it('reserves stock for a PENDING order and counts the attempt', async () => {
    givenOrder('Maria');

    await processor.process(aJob(0));

    expect(processing.recordAttempt).toHaveBeenCalledWith(orderId);
    expect(processing.reserveAndConfirm).toHaveBeenCalledWith(orderId);
    expect(processing.markFailed).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.PROCESSED, OrderStatus.FAILED])(
    'does nothing for an order already %s',
    async (status) => {
      givenOrder('Maria', status);

      await processor.process(aJob(0));

      expect(processing.recordAttempt).not.toHaveBeenCalled();
      expect(processing.reserveAndConfirm).not.toHaveBeenCalled();
    },
  );

  it('does nothing for an order that does not exist', async () => {
    processing.findForProcessing.mockResolvedValue(null);

    await expect(processor.process(aJob(0))).resolves.toBeUndefined();
    expect(processing.reserveAndConfirm).not.toHaveBeenCalled();
  });

  it('throws for "fail" in the name before reserving, so BullMQ retries', async () => {
    givenOrder('Cliente FAIL');

    await expect(processor.process(aJob(0))).rejects.toBeInstanceOf(
      SimulatedProcessingError,
    );

    expect(processing.reserveAndConfirm).not.toHaveBeenCalled();
    expect(processing.markFailed).not.toHaveBeenCalled();
    expect(deadLetter.add).not.toHaveBeenCalled();
  });

  it('on the last attempt dead-letters the job, then marks the order FAILED', async () => {
    givenOrder('fail');

    await expect(processor.process(aJob(2))).rejects.toBeInstanceOf(
      SimulatedProcessingError,
    );

    expect(deadLetter.add).toHaveBeenCalledWith(
      'order.failed',
      expect.objectContaining({
        orderId,
        correlationId: 'corr-1',
        reason: 'falha simulada no processamento',
        attempts: 3,
      }),
      { jobId: `${orderId}-event-1` },
    );
    expect(processing.markFailed).toHaveBeenCalledWith(
      orderId,
      'falha simulada no processamento',
    );
    expect(deadLetter.add.mock.invocationCallOrder[0]).toBeLessThan(
      processing.markFailed.mock.invocationCallOrder[0],
    );
  });

  it('fails an order without stock at once, without retry nor DLQ', async () => {
    givenOrder('Maria');
    processing.reserveAndConfirm.mockRejectedValue(
      new InsufficientStockError('Mouse'),
    );

    await expect(processor.process(aJob(0))).resolves.toBeUndefined();

    expect(processing.markFailed).toHaveBeenCalledWith(
      orderId,
      'estoque insuficiente: Mouse',
    );
    expect(deadLetter.add).not.toHaveBeenCalled();
  });

  it('handles the job under the correlation id it carries', async () => {
    givenOrder('Maria');
    let seen: string | undefined;
    processing.reserveAndConfirm.mockImplementation(() => {
      seen = currentCorrelationId();
      return Promise.resolve(ReservationOutcome.PROCESSED);
    });

    await processor.process(aJob(0));

    expect(seen).toBe('corr-1');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('retries an unexpected technical error from the reservation', async () => {
    givenOrder('Maria');
    processing.reserveAndConfirm.mockRejectedValue(new Error('db timeout'));

    await expect(processor.process(aJob(0))).rejects.toThrow('db timeout');
    expect(processing.markFailed).not.toHaveBeenCalled();
  });
});
