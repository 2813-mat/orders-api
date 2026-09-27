import { OrderStatus } from '../domain/order-status.enum';
import { Order } from '../entities/order.entity';

export interface OrderItemResponse {
  productName: string;
  quantity: number;
  price: number;
  subtotal: number;
}

export interface OrderResponse {
  id: string;
  customerName: string;
  status: OrderStatus;
  total: number;
  failureReason: string | null;
  items: OrderItemResponse[];
  createdAt: Date;
  processedAt: Date | null;
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
