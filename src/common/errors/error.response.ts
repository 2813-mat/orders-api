import { ApiProperty } from '@nestjs/swagger';

/** Nest's standard error body, as every error of this API is returned. */
export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['items must contain at least 1 elements'],
    description: 'One message, or one per invalid field (400)',
  })
  message: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error: string;
}
