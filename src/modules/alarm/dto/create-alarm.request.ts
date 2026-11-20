import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AlarmType, URGENT_MAX_RECIPIENTS } from '../alarm-type.enum';

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
  type?: AlarmType;

  @ApiProperty({ description: '제목 (1~200자)', example: '11월 정기 점검 안내', required: true })
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiProperty({
    description: '본문 (1~2000자)',
    example: '11월 25일 02:00~04:00 서비스 점검이 있습니다.',
    required: true,
  })
  @IsString()
  @Length(1, 2000)
  body: string;

  @ApiProperty({
    description: `긴급(URGENT) 알림의 수신자 id 목록 (1~${URGENT_MAX_RECIPIENTS}명, mock 사용자 id). BULK 에서는 지정 불가`,
    example: ['u_000001', 'u_000002'],
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(URGENT_MAX_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  recipientIds?: string[];
}
