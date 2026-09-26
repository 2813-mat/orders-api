import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opts a route (or controller) out of the global JWT guard, e.g. /health. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
