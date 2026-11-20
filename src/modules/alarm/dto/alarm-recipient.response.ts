import { ApiProperty } from '@nestjs/swagger';

import { AlarmRecipient } from '../alarm-recipient.entity';
import { RecipientStatus } from '../recipient-status.enum';

export class AlarmRecipientResponse {
  @ApiProperty({ description: '수신자 id (mock 사용자 id)', example: 'u_000001', required: true })
  recipientId: string;

  @ApiProperty({ description: '발송 상태', enum: RecipientStatus, example: RecipientStatus.SENT, required: true })
  status: RecipientStatus;

  @ApiProperty({ description: '5xx 재시도 횟수', example: 0, required: true })
  attemptCount: number;

  @ApiProperty({
    description: 'mock 이 돌려준 메시지 id. 미발송이면 null',
    example: 'm_1',
    required: false,
    nullable: true,
  })
  messageId: string | null;

  @ApiProperty({
    description: '마지막 오류 코드. 없으면 null',
    example: 'RECIPIENT_BLOCKED',
    required: false,
    nullable: true,
  })
  lastError: string | null;

  @ApiProperty({
    description: '발송 시각. 미발송이면 null',
    type: String,
    format: 'date-time',
    example: '2026-11-20T10:00:00.000Z',
    required: false,
    nullable: true,
  })
  sentAt: Date | null;

  static from(row: AlarmRecipient): AlarmRecipientResponse {
    const res = new AlarmRecipientResponse();
    res.recipientId = row.recipientId;
    res.status = row.status;
    res.attemptCount = row.attemptCount;
    res.messageId = row.messageId;
    res.lastError = row.lastError;
    res.sentAt = row.sentAt;
    return res;
  }
}
