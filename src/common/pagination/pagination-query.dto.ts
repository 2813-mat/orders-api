import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { PageRequest } from './page';

export class PaginationQueryDto implements PageRequest {
  /** Bounded so OFFSET stays reasonable; deep paging would need a cursor. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10;
}
