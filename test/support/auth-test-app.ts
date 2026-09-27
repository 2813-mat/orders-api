import {
  INestApplication,
  ModuleMetadata,
  Provider,
  Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthModule } from '../../src/auth/auth.module';
import { FakeIdp } from './fake-idp';

export interface AuthTestApp {
  app: INestApplication<App>;
  idp: FakeIdp;
  get: (path: string, token?: string) => request.Test;
  post: (path: string, body: object, token?: string) => request.Test;
  close: () => Promise<void>;
}

/**
 * Boots the real AuthModule (JwtStrategy + global guards) against a FakeIdp,
 * with the given controllers standing in for the API routes.
 */
export async function createAuthTestApp(
  controllers: Type[],
  options: {
    imports?: ModuleMetadata['imports'];
    providers?: Provider[];
    config?: Record<string, unknown>;
  } = {},
): Promise<AuthTestApp> {
  const idp = await FakeIdp.start();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ ...idp.env, ...options.config })],
      }),
      AuthModule,
      ...(options.imports ?? []),
    ],
    controllers,
    providers: options.providers,
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();

  return {
    app,
    idp,
    get: (path, token) => {
      const req = request(app.getHttpServer()).get(path);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    },
    post: (path, body, token) => {
      const req = request(app.getHttpServer()).post(path).send(body);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    },
    close: async () => {
      await app.close();
      await idp.stop();
    },
  };
}
