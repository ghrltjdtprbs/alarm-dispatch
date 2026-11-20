import { ApiProperty } from '@nestjs/swagger';

// 목록 조회 공통 응답. page 는 0-based (docs/conventions/api.md §4)
export class PagedResponse<T> {
  @ApiProperty({ description: '현재 페이지 항목', isArray: true, example: [], required: true })
  items: T[];

  @ApiProperty({ description: '페이지 번호 (0-based)', example: 0, required: true })
  page: number;

  @ApiProperty({ description: '페이지 크기', example: 10, required: true })
  size: number;

  @ApiProperty({ description: '전체 항목 수', example: 42, required: true })
  totalElements: number;

  @ApiProperty({ description: '전체 페이지 수', example: 5, required: true })
  totalPages: number;

  private constructor(items: T[], page: number, size: number, totalElements: number) {
    this.items = items;
    this.page = page;
    this.size = size;
    this.totalElements = totalElements;
    this.totalPages = size > 0 ? Math.ceil(totalElements / size) : 0;
  }

  static of<T>(items: T[], page: number, size: number, totalElements: number): PagedResponse<T> {
    return new PagedResponse(items, page, size, totalElements);
  }
}
