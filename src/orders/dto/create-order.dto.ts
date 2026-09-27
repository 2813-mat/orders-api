import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OrderItemDto {
  @ApiProperty({
    example: 'Mouse',
    maxLength: 120,
    description:
      'Must match a catalog product (case-insensitive): Notebook, Mouse or Teclado in the seed. Unknown names → 422.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  productName: string;

  /** Upper bound keeps quantity well inside INT UNSIGNED. */
  @ApiProperty({ example: 2, minimum: 1, maximum: 1_000_000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity: number;

  /** Unit price; the total is computed by the API, never taken from the client. */
  @ApiProperty({
    example: 49.9,
    minimum: 0,
    description: 'Unit price, at most 2 decimal places',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  price: number;
}

export class CreateOrderDto {
  @ApiProperty({
    example: 'Maria Silva',
    maxLength: 120,
    description:
      'A name containing "fail" (any case) makes processing fail on purpose: retried, then FAILED and sent to the dead-letter queue.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  customerName: string;

  @ApiProperty({ type: [OrderItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
