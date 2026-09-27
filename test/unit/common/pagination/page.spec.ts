import {
  buildPageMeta,
  pageOffset,
} from '../../../../src/common/pagination/page';

describe('pagination', () => {
  it('computes the total number of pages', () => {
    expect(buildPageMeta({ page: 1, limit: 10 }, 25)).toEqual({
      page: 1,
      limit: 10,
      total: 25,
      totalPages: 3,
    });
  });

  it('counts an exact multiple without an extra page', () => {
    expect(buildPageMeta({ page: 2, limit: 10 }, 20).totalPages).toBe(2);
  });

  it('reports zero pages when there is nothing', () => {
    expect(buildPageMeta({ page: 1, limit: 10 }, 0).totalPages).toBe(0);
  });

  it('keeps the requested page even past the last one', () => {
    expect(buildPageMeta({ page: 9, limit: 10 }, 5)).toMatchObject({
      page: 9,
      totalPages: 1,
    });
  });

  it('skips the rows of the previous pages', () => {
    expect(pageOffset({ page: 1, limit: 10 })).toBe(0);
    expect(pageOffset({ page: 3, limit: 20 })).toBe(40);
  });
});
