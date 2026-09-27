import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

/** Validated env for every process (API, relay, worker): none starts with bad config. */
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateEnv,
});
