import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { EnvironmentVariables } from '../../config/env.validation';
import {
  CORRELATION_ID_HEADER,
  currentCorrelationId,
  resolveCorrelationId,
} from '../correlation/correlation-id';

/**
 * Structured JSON logs (pino) where every line carries the correlation id of
 * the request or job being handled. `http: true` (the API) also starts a
 * correlation context per request and echoes the id in the response header;
 * the relay and the worker open their own contexts.
 */
@Module({})
export class LoggingModule {
  static forRoot({ http }: { http: boolean }): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: {
            mount: http,
            generateId: true,
            idGenerator: resolveCorrelationId,
            setup: (
              cls,
              _req,
              res: { setHeader(k: string, v: string): void },
            ) => res.setHeader(CORRELATION_ID_HEADER, cls.getId()),
          },
        }),
        LoggerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
            pinoHttp: {
              level: config.get('LOG_LEVEL', { infer: true }),
              // Same id as the CLS context, whichever middleware runs first.
              genReqId: resolveCorrelationId,
              mixin: () => ({ correlationId: currentCorrelationId() }),
              redact: ['req.headers.authorization', 'req.headers.cookie'],
              // The compose healthcheck calls /health every 10s: keep it quiet.
              autoLogging: http && {
                ignore: (req) => req.url?.startsWith('/health') ?? false,
              },
              // Human-friendly only on an interactive terminal; JSON in Docker.
              transport: process.stdout.isTTY
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
            },
          }),
        }),
      ],
    };
  }
}
