import { Provider, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

/**
 * Global request validation, registered as a provider (not in main.ts) so the
 * same rules apply to any app built from the modules, tests included.
 */
export const validationPipeProvider: Provider = {
  provide: APP_PIPE,
  useValue: new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
};
