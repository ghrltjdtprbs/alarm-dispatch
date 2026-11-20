import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// 목록 조회 공통 쿼리. 프론트가 생략해도 동작하도록 기본값을 둔다 (page 0-based, size 기본 10)
export class PaginationQuery {
  @ApiProperty({ description: '페이지 번호 (0-based)', example: 0, required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page: number = 0;

  @ApiProperty({ description: '페이지 크기 (최대 100)', example: 10, required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 10;

  get offset(): number {
    return this.page * this.size;
  }
}
