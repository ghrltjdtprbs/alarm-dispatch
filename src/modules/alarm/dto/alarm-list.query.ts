import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQuery } from '../../../common/dto/pagination-query.dto';
import { AlarmStatus } from '../alarm-status.enum';
import { AlarmType } from '../alarm-type.enum';

export class AlarmListQuery extends PaginationQuery {
  @ApiProperty({ description: '상태 필터', enum: AlarmStatus, example: AlarmStatus.SENDING, required: false })
  @IsOptional()
  @IsEnum(AlarmStatus)
  status?: AlarmStatus;

  @ApiProperty({ description: '종류 필터', enum: AlarmType, example: AlarmType.BULK, required: false })
  @IsOptional()
  @IsEnum(AlarmType)
  type?: AlarmType;
}
