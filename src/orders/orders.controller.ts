import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { Page } from '../common/pagination/page';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
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

  /** USER: own orders only. ADMIN: all of them. */
  @Get()
  async list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<OrderResponse>> {
    const { data, meta } = await this.orders.list(query, user);
    return { data: data.map(toOrderResponse), meta };
  }

  /** 404 also for another user's order, so ids can't be probed. */
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderResponse> {
    const order = await this.orders.findOne(id, user);
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return toOrderResponse(order);
  }
}
