import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { validationPipeProvider } from './common/validation';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OrdersModule } from './orders/orders.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthModule,
    UsersModule,
    OrdersModule,
  ],
  providers: [validationPipeProvider],
})
export class AppModule {}
