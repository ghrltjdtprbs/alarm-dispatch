import { ApiProperty } from '@nestjs/swagger';

import { RecipientStatusCounts } from '../alarm-recipient.repository';
import { RecipientStatus } from '../recipient-status.enum';

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
