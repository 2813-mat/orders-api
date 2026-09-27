import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { LoggingModule } from './common/logging/logging.module';
import { validationPipeProvider } from './common/validation';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule.forRoot({ http: true }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [validationPipeProvider],
})
export class AppModule {}
