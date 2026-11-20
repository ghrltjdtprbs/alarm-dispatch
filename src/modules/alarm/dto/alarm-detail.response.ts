import { ApiProperty } from '@nestjs/swagger';

import { Alarm } from '../alarm.entity';
import { RecipientStatusCounts } from '../alarm-recipient.repository';
import { AlarmResponse } from './alarm.response';
import { AlarmProgress } from './alarm-progress.response';

export class AlarmDetailResponse extends AlarmResponse {
  @ApiProperty({
    description: '발송 진행 상황 (수신자 상태별 건수)',
    type: AlarmProgress,
    example: { total: 100000, pending: 40000, processing: 20, sent: 59000, failed: 980, unknown: 0, cancelled: 0 },
    required: true,
  })
  progress: AlarmProgress;

  static fromDetail(alarm: Alarm, counts: RecipientStatusCounts): AlarmDetailResponse {
    const res = Object.assign(new AlarmDetailResponse(), AlarmResponse.from(alarm));
    res.progress = AlarmProgress.from(counts);
    return res;
  }
}
