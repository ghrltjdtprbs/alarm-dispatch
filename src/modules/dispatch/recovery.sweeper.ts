import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration } from '../../common/config/configuration';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { AlarmRepository } from '../alarm/alarm.repository';
import { DispatchQueueProducer } from './dispatch-queue.producer';

const SWEEP_BATCH = 5_000;
// 이 시간보다 오래 UNKNOWN/PENDING 에 머문 행은 잡이 유실된 것으로 본다 (정상 재시도 백오프 최대 30초보다 넉넉히)
const STALE_RECIPIENT_SEC = 120;
const STALE_PREPARING_SEC = 180;

/**
 * 큐에 없는데 DB 에선 끝나지 않은 건을 다시 큐에 넣는 안전망. 주기 실행, 워커마다 돌아도 안전하다
 * (재투입은 jobId 로 중복 무시, 상태 변경은 전부 조건부 UPDATE).
 * BullMQ 의 stalled 복구가 1차, 이 스윕이 2차 방어선이다 — 잡이 maxStalledCount 를 넘겨 버려지거나 Redis 가 비워져도 발송이 멈추지 않는다.
 */
@Injectable()
export class RecoverySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoverySweeper.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly alarmRepository: AlarmRepository,
    private readonly recipientRepository: AlarmRecipientRepository,
    private readonly producer: DispatchQueueProducer,
    config: ConfigService<Configuration, true>,
  ) {
    this.intervalMs = config.get('worker', { infer: true }).recoverySweepIntervalMs;
  }

  onModuleInit(): void {
    // 워커들이 같은 순간에 몰리지 않도록 시작 시점을 흩뜨린다
    const jitter = Math.floor(Math.random() * this.intervalMs);
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.sweep(), this.intervalMs);
      void this.sweep();
    }, jitter);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const alarms = await this.recoverOrphanAlarms();
      const recipients = await this.recoverOrphanRecipients();
      if (alarms + recipients > 0) this.logger.log(`[복구 스윕] alarms=${alarms} recipients=${recipients}`);
    } catch (error) {
      this.logger.error(`[복구 스윕 실패] ${(error as Error).message}`, (error as Error).stack);
    } finally {
      this.running = false;
    }
  }

  // PREPARING 에 오래 머문 알림 = prepare 잡 유실. 다시 투입 (jobId 같으면 무시)
  private async recoverOrphanAlarms(): Promise<number> {
    const stale = await this.alarmRepository.findStaleByStatus(AlarmStatus.PREPARING, STALE_PREPARING_SEC, 100);
    for (const alarm of stale) await this.producer.enqueuePrepare(alarm.id, alarm.type);
    return stale.length;
  }

  private async recoverOrphanRecipients(): Promise<number> {
    const rows = await this.recipientRepository.findRecoverable(STALE_RECIPIENT_SEC, SWEEP_BATCH);
    const byAlarm = new Map<string, { type: AlarmType; ids: string[] }>();
    for (const row of rows) {
      const group = byAlarm.get(row.alarmId) ?? { type: row.type, ids: [] };
      group.ids.push(row.recipientId);
      byAlarm.set(row.alarmId, group);
    }
    for (const [alarmId, group] of byAlarm) await this.producer.enqueueSendBatch(alarmId, group.type, group.ids);
    return rows.length;
  }
}
