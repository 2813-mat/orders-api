import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Response } from 'express';
import { InvalidOrderError } from '../domain/errors';

/**
 * The request is well-formed (the ValidationPipe already said so) but breaks a
 * business rule, e.g. an unknown product: 422, in Nest's usual error shape.
 */
@Catch(InvalidOrderError)
export class InvalidOrderFilter implements ExceptionFilter<InvalidOrderError> {
  catch(error: InvalidOrderError, host: ArgumentsHost): void {
    const exception = new UnprocessableEntityException(error.message);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .json(exception.getResponse());
  }
}
