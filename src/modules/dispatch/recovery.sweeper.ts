import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration } from '../../common/config/configuration';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { AlarmRepository } from '../alarm/alarm.repository';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DISPATCH_QUEUE } from './dispatch-job';
import { DispatchQueueProducer } from './dispatch-queue.producer';

const SWEEP_BATCH = 5_000;
// 이 시간보다 오래 UNKNOWN 에 머문 행은 잡이 유실된 것으로 본다 (정상 재시도 백오프 최대 30초보다 넉넉히)
const STALE_RECIPIENT_SEC = 120;
// PENDING 은 10만 건 대기열에서 정상적으로 수십 분 머무른다. 큐가 비어 있으면 즉시, 아니면 1시간 뒤 잡 유실로 본다
const STALE_PENDING_SEC = 3_600;
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
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
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
    // 큐가 비어 있는데 PENDING 이 남아 있으면 잡 유실이 확실하므로 기다리지 않고 바로 재투입한다
    const queueIdle = (await this.queue.getJobCountByTypes('waiting', 'prioritized', 'delayed', 'active')) === 0;
    const pendingStaleSec = queueIdle ? 0 : STALE_PENDING_SEC;
    const rows = await this.recipientRepository.findRecoverable(STALE_RECIPIENT_SEC, pendingStaleSec, SWEEP_BATCH);
    const byAlarm = new Map<string, { type: AlarmType; ids: string[] }>();
    for (const row of rows) {
      const group = byAlarm.get(row.alarmId) ?? { type: row.type, ids: [] };
      group.ids.push(row.recipientId);
      byAlarm.set(row.alarmId, group);
    }
    for (const [alarmId, group] of byAlarm) {
      const { added, promoted } = await this.producer.requeueOrPromote(alarmId, group.type, group.ids);
      if (added + promoted > 0) this.logger.log(`[복구 재투입] alarm=${alarmId} added=${added} promoted=${promoted}`);
    }
    return rows.length;
  }
}
