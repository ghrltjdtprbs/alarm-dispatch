import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { BaseEntity } from '../../common/entity/base.entity';
import { Alarm } from './alarm.entity';
import { RecipientStatus } from './recipient-status.enum';

/**
 * 수신자별 발송 상태 (알림당 최대 10만 행). 상태는 워커가 조건부 UPDATE 로만 바꾼다.
 * - (alarm_id, recipient_id) 유니크: 수신자 적재를 몇 번 재실행해도 중복 행이 생기지 않는다 (ON CONFLICT DO NOTHING)
 * - (alarm_id, status) 인덱스: 진행률 집계·완료 판정·취소 일괄 UPDATE 가 모두 이 조건으로 돈다
 * - PK 는 bigint: 행 수가 많아 uuid 보다 인덱스가 작다
 */
@Entity('alarm_recipients')
@Unique('uq_alarm_recipients_alarm_recipient', ['alarmId', 'recipientId'])
@Index('idx_alarm_recipients_alarm_status', ['alarmId', 'status'])
export class AlarmRecipient extends BaseEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'alarm_id', type: 'uuid' })
  alarmId: string;

  @ManyToOne(() => Alarm, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'alarm_id' })
  alarm: Alarm;

  // mock 사용자 id (u_000001)
  @Column({ name: 'recipient_id', type: 'varchar', length: 32 })
  recipientId: string;

  @Column({ type: 'varchar', length: 20 })
  status: RecipientStatus;

  // 5xx 재시도 횟수. 429 는 세지 않는다
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  // PROCESSING 점유 만료 시각. 만료 후에도 PROCESSING 이면 처리하던 워커가 죽은 것 → 복구 대상
  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ name: 'message_id', type: 'varchar', length: 64, nullable: true })
  messageId: string | null;

  @Column({ name: 'last_error', type: 'varchar', length: 64, nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  // mock 에 보내는 clientRef. 결정적 값이라 타임아웃 뒤 GET /v1/messages?clientRef= 로 처리 여부를 확인할 수 있다
  static clientRef(alarmId: string, recipientId: string): string {
    return `${alarmId}:${recipientId}`;
  }
}
