import { Body, Controller, Post, UseFilters } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponse, toOrderResponse } from './dto/order.response';
import { InvalidOrderFilter } from './invalid-order.filter';
import { OrdersService } from './orders.service';

@Controller('orders')
@Roles(Role.USER, Role.ADMIN)
@UseFilters(InvalidOrderFilter)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * 201 with the order still PENDING: it is created now, processing happens
   * asynchronously and is followed through GET /orders/:id.
   */
  @Post()
  async create(
    @Body() body: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderResponse> {
    return toOrderResponse(await this.orders.create(body, user));
  }
}
