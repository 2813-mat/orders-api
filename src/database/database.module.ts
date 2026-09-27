import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { buildTypeOrmOptions } from './typeorm.options';

/** MySQL connection shared by every process (API, relay, worker). */
export const DatabaseModule = TypeOrmModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
    buildTypeOrmOptions({
      DB_HOST: config.get('DB_HOST', { infer: true }),
      DB_PORT: config.get('DB_PORT', { infer: true }),
      DB_USER: config.get('DB_USER', { infer: true }),
      DB_PASSWORD: config.get('DB_PASSWORD', { infer: true }),
      DB_NAME: config.get('DB_NAME', { infer: true }),
    }),
});
