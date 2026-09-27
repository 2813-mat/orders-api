import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../auth/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  /**
   * 200 when the API can serve requests, 503 otherwise. Only MySQL is checked:
   * creating an order doesn't need Redis (the outbox absorbs a Redis outage),
   * so Redis being down must not take the API out of rotation.
   */
  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: 200 if MySQL answers, 503 otherwise',
    description:
      'Public. Redis is deliberately not checked: creating orders does not need it.',
  })
  check() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1500),
    ]);
  }
}
