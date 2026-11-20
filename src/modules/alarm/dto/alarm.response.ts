import { ApiProperty } from '@nestjs/swagger';
import { RecipientStatusCounts } from '../alarm-recipient.repository';
import { AlarmStatus } from '../alarm-status.enum';
import { AlarmType } from '../alarm-type.enum';
import { Alarm } from '../alarm.entity';
import { RecipientStatus } from '../recipient-status.enum';

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

// 수신자 상태별 건수. total = 모든 상태의 합
export class AlarmProgress {
  @ApiProperty({ description: '전체 수신자 수 (적재 중에는 증가한다)', example: 100000, required: true })
  total: number;

  @ApiProperty({ description: '대기 중', example: 40000, required: true })
  pending: number;

  @ApiProperty({ description: '호출 중', example: 20, required: true })
  processing: number;

  @ApiProperty({ description: '발송 성공', example: 59000, required: true })
  sent: number;

  @ApiProperty({ description: '영구 실패 (수신 거부 등)', example: 980, required: true })
  failed: number;

  @ApiProperty({ description: '타임아웃으로 결과 확인 중', example: 0, required: true })
  unknown: number;

  @ApiProperty({ description: '취소로 발송하지 않음', example: 0, required: true })
  cancelled: number;

  static from(counts: RecipientStatusCounts): AlarmProgress {
    const p = new AlarmProgress();
    p.pending = counts[RecipientStatus.PENDING];
    p.processing = counts[RecipientStatus.PROCESSING];
    p.sent = counts[RecipientStatus.SENT];
    p.failed = counts[RecipientStatus.FAILED];
    p.unknown = counts[RecipientStatus.UNKNOWN];
    p.cancelled = counts[RecipientStatus.CANCELLED];
    p.total = p.pending + p.processing + p.sent + p.failed + p.unknown + p.cancelled;
    return p;
  }
}

export class AlarmDetailResponse extends AlarmResponse {
  @ApiProperty({
    description: '발송 진행 상황',
    type: AlarmProgress,
    example: { total: 100000, sent: 59000 },
    required: true,
  })
  progress: AlarmProgress;

  static fromDetail(alarm: Alarm, counts: RecipientStatusCounts): AlarmDetailResponse {
    const res = Object.assign(new AlarmDetailResponse(), AlarmResponse.from(alarm));
    res.progress = AlarmProgress.from(counts);
    return res;
  }
}
