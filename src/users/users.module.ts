import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UserSyncInterceptor } from './interceptors/user-sync.interceptor';
import { UsersRepository } from './repositories/users.repository';
import { UsersService } from './services/users.service';

@Module({
  providers: [
    UsersService,
    UsersRepository,
    { provide: APP_INTERCEPTOR, useClass: UserSyncInterceptor },
  ],
  exports: [UsersService],
})
export class UsersModule {}
