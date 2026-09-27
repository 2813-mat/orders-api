import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CORRELATION_ID_HEADER } from '../../common/correlation/correlation-id';
import { ErrorResponse } from '../../common/errors/error.response';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { CreateOrderDto } from '../dto/create-order.dto';
import {
  OrderPage,
  OrderResponse,
  toOrderResponse,
} from '../dto/order.response';
import { InvalidOrderFilter } from '../filters/invalid-order.filter';
import { OrdersService } from '../services/orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@ApiHeader({
  name: CORRELATION_ID_HEADER,
  required: false,
  description:
    'UUID that follows the order through the API, the queue and the worker logs. Generated when absent or not a UUID; always echoed in the response.',
})
@ApiUnauthorizedResponse({
  type: ErrorResponse,
  description: 'Missing, expired or invalid Keycloak token',
})
@ApiForbiddenResponse({
  type: ErrorResponse,
  description: 'Token without the required realm role',
})
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
  @ApiOperation({
    summary: 'Create an order',
    description:
      'Computes the total and saves the order as PENDING together with its order.created event (transactional outbox). Stock is reserved later by the worker: poll GET /orders/{id} for PROCESSED or FAILED. Roles: USER, ADMIN.',
  })
  @ApiCreatedResponse({ type: OrderResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'Invalid body (field-level messages)',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponse,
    description: 'Unknown product, or a total too large to store',
  })
  async create(
    @Body() body: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderResponse> {
    return toOrderResponse(await this.orders.create(body, user));
  }

  /** USER: own orders only. ADMIN: all of them. */
  @Get()
  @ApiOperation({
    summary: 'List orders, newest first',
    description: 'USER sees only their own orders; ADMIN sees every order.',
  })
  @ApiOkResponse({ type: OrderPage })
  @ApiBadRequestResponse({ type: ErrorResponse })
  async list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderPage> {
    const { data, meta } = await this.orders.list(query, user);
    return { data: data.map(toOrderResponse), meta };
  }

  /** 404 also for another user's order, so ids can't be probed. */
  @Get(':id')
  @ApiOperation({
    summary: 'Get an order and its current status',
    description:
      "USER can only read their own orders: another user's order answers 404, like a missing one.",
  })
  @ApiOkResponse({ type: OrderResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'Id is not a UUID',
  })
  @ApiNotFoundResponse({ type: ErrorResponse })
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

  /**
   * ADMIN only. 202: the order is PENDING again and will be picked up by the
   * worker; follow it through GET /orders/:id.
   */
  @Post(':id/reprocess')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reprocess a FAILED order',
    description:
      'Puts the order back to PENDING and queues it again (new outbox event). Only FAILED orders; a FAILED order never holds reserved stock, so this cannot take stock twice. Role: ADMIN.',
  })
  @ApiAcceptedResponse({ type: OrderResponse })
  @ApiBadRequestResponse({
    type: ErrorResponse,
    description: 'Id is not a UUID',
  })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description: 'The order is not FAILED',
  })
  async reprocess(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponse> {
    const result = await this.orders.reprocess(id);
    switch (result.outcome) {
      case 'REQUEUED':
        return toOrderResponse(result.order);
      case 'NOT_FAILED':
        throw new ConflictException(
          `Only FAILED orders can be reprocessed; order ${id} is ${result.status}`,
        );
      case 'NOT_FOUND':
        throw new NotFoundException(`Order ${id} not found`);
    }
  }
}
