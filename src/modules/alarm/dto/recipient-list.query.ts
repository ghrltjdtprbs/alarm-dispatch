import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQuery } from '../../../common/dto/pagination-query.dto';
import { RecipientStatus } from '../recipient-status.enum';

export class RecipientListQuery extends PaginationQuery {
  @ApiProperty({
    description: '수신자 상태 필터',
    enum: RecipientStatus,
    example: RecipientStatus.FAILED,
    required: false,
  })
  @IsOptional()
  @IsEnum(RecipientStatus)
  status?: RecipientStatus;
}
