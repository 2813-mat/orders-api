import { ApiProperty } from '@nestjs/swagger';

export interface PageRequest {
  page: number;
  limit: number;
}

export class PageMeta implements PageRequest {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 42, description: 'Items across all pages' })
  total: number;

  @ApiProperty({ example: 5 })
  totalPages: number;
}

export interface Page<T> {
  data: T[];
  meta: PageMeta;
}

export function pageOffset({ page, limit }: PageRequest): number {
  return (page - 1) * limit;
}

/** A page past the last one is not an error: it is just empty. */
export function buildPageMeta(request: PageRequest, total: number): PageMeta {
  return { ...request, total, totalPages: Math.ceil(total / request.limit) };
}
