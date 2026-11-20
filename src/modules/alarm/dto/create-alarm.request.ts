import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { AlarmType, URGENT_MAX_RECIPIENTS } from '../alarm-type.enum';

export const TITLE_MAX_LENGTH = 200;
export const BODY_MAX_LENGTH = 2000;
// mock 사용자 id 형식 (u_000001). 공백·빈 문자열을 막는다
const RECIPIENT_ID_PATTERN = /^\S{1,32}$/;

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class CreateAlarmRequest {
  @ApiProperty({
    description: '알림 종류. BULK 는 전체 사용자, URGENT 는 지정 수신자에게 우선 발송',
    enum: AlarmType,
    example: AlarmType.BULK,
    required: false,
    default: AlarmType.BULK,
  })
  @IsOptional()
  @IsEnum(AlarmType)
  type: AlarmType = AlarmType.BULK;

  @ApiProperty({
    description: `제목 (공백 제외 1~${TITLE_MAX_LENGTH}자)`,
    example: '11월 정기 점검 안내',
    required: true,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX_LENGTH)
  title: string;

  @ApiProperty({
    description: `본문 (공백 제외 1~${BODY_MAX_LENGTH}자)`,
    example: '11월 25일 02:00~04:00 서비스 점검이 있습니다.',
    required: true,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX_LENGTH)
  body: string;

  @ApiProperty({
    description: `긴급(URGENT) 알림의 수신자 id 목록 (1~${URGENT_MAX_RECIPIENTS}명, mock 사용자 id 형식 u_000001). BULK 에서는 지정 불가`,
    example: ['u_000001', 'u_000002'],
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(URGENT_MAX_RECIPIENTS)
  @IsString({ each: true })
  @Matches(RECIPIENT_ID_PATTERN, {
    each: true,
    message: 'each value in recipientIds must be a non-empty id without whitespace',
  })
  recipientIds?: string[];
}
