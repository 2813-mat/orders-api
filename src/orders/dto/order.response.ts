import { ApiProperty } from '@nestjs/swagger';
import { PageMeta } from '../../common/pagination/page';
import { OrderStatus } from '../domain/order-status.enum';
import { Order } from '../../database/entities/order.entity';

export class OrderItemResponse {
  @ApiProperty({ example: 'Mouse' })
  productName: string;

  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiProperty({ example: 49.9, description: 'Unit price' })
  price: number;

  @ApiProperty({ example: 99.8, description: 'quantity × price' })
  subtotal: number;
}

export class OrderResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Silva' })
  customerName: string;

  @ApiProperty({
    enum: OrderStatus,
    enumName: 'OrderStatus',
    description:
      'PENDING until the worker processes it; PROCESSED once stock is reserved; FAILED with failureReason otherwise.',
  })
  status: OrderStatus;

  @ApiProperty({ example: 99.8 })
  total: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Why the order FAILED, e.g. "estoque insuficiente: Mouse" or "falha simulada no processamento".',
  })
  failureReason: string | null;

  @ApiProperty({ type: [OrderItemResponse] })
  items: OrderItemResponse[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true, example: null })
  processedAt: Date | null;
}

export class OrderPage {
  @ApiProperty({ type: [OrderResponse] })
  data: OrderResponse[];

  @ApiProperty({ type: PageMeta })
  meta: PageMeta;
}

/** Keeps internal columns (created_by_sub, attempts, correlation id) private. */
export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    customerName: order.customerName,
    status: order.status,
    total: order.total,
    failureReason: order.failureReason,
    items: order.items.map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      price: item.unitPrice,
      subtotal: item.subtotal,
    })),
    createdAt: order.createdAt,
    processedAt: order.processedAt,
  };
}
