import { ApiProperty } from '@nestjs/swagger';

import { Alarm } from '../alarm.entity';
import { AlarmStatus } from '../alarm-status.enum';
import { AlarmType } from '../alarm-type.enum';

export class AlarmResponse {
  @ApiProperty({ description: '알림 id (uuid)', example: '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70', required: true })
  id: string;

  @ApiProperty({ description: '알림 종류', enum: AlarmType, example: AlarmType.BULK, required: true })
  type: AlarmType;

  @ApiProperty({ description: '제목', example: '11월 정기 점검 안내', required: true })
  title: string;

  @ApiProperty({ description: '본문', example: '11월 25일 02:00~04:00 서비스 점검이 있습니다.', required: true })
  body: string;

  @ApiProperty({ description: '알림 상태', enum: AlarmStatus, example: AlarmStatus.CREATED, required: true })
  status: AlarmStatus;

  @ApiProperty({
    description: '생성 시각',
    type: String,
    format: 'date-time',
    example: '2026-11-20T10:00:00.000Z',
    required: true,
  })
  createdAt: Date;

  @ApiProperty({
    description: '수정 시각',
    type: String,
    format: 'date-time',
    example: '2026-11-20T10:00:00.000Z',
    required: true,
  })
  updatedAt: Date;

  static from(alarm: Alarm): AlarmResponse {
    const res = new AlarmResponse();
    res.id = alarm.id;
    res.type = alarm.type;
    res.title = alarm.title;
    res.body = alarm.body;
    res.status = alarm.status;
    res.createdAt = alarm.createdAt;
    res.updatedAt = alarm.updatedAt;
    return res;
  }
}
