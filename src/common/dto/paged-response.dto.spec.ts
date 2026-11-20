import { PagedResponse } from './paged-response.dto';

describe('PagedResponse', () => {
  it('전체 페이지 수를 올림으로 계산한다', () => {
    const page = PagedResponse.of(['a'], 0, 10, 42);
    expect(page.totalPages).toBe(5);
    expect(page.totalElements).toBe(42);
  });

  it('항목이 없으면 전체 페이지 수는 0 이다', () => {
    expect(PagedResponse.of([], 0, 10, 0).totalPages).toBe(0);
  });
});
