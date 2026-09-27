export interface PageRequest {
  page: number;
  limit: number;
}

export interface PageMeta extends PageRequest {
  total: number;
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
