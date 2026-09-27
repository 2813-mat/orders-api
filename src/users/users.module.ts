import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSyncInterceptor } from './user-sync.interceptor';
import { User } from '../database/entities/user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [
    UsersService,
    { provide: APP_INTERCEPTOR, useClass: UserSyncInterceptor },
  ],
  exports: [UsersService],
})
export class UsersModule {}
