import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration } from '../../common/config/configuration';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmRecipient } from '../alarm/alarm-recipient.entity';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmRepository } from '../alarm/alarm.repository';
import { Alarm } from '../alarm/alarm.entity';
import { RecipientStatus } from '../alarm/recipient-status.enum';
import { SendJobData } from './dispatch-job';
import { RATE_LIMITER, RateLimiter } from './rate-limiter';
import { SEND_CLIENT, SendClient, SendResult } from './send-client';

// 잡 처리 결과. 프로세서가 BullMQ 동작(완료 / 지연 재투입 / 전역 일시정지)으로 옮긴다
export type SendOutcome =
  | { action: 'done'; reason: string }
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'rate_limited'; retryAfterMs: number };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// 타임아웃 뒤 clientRef 조회까지 기다리는 시간. mock 은 발송 처리 후 30초 무응답이므로 조회는 바로 가능하다
const RECONCILE_DELAY_MS = 3_000;

/**
 * 수신자 1명 발송: claim(조건부 UPDATE) → call(트랜잭션 밖, 토큰 버킷) → settle(조건부 UPDATE).
 * 상태의 진실은 DB 행이다. 잡이 몇 번 재전달되든 행 상태를 보고 할 일을 정하므로 중복 발송이 없다.
 */
@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);
  private readonly maxAttempts: number;
  private readonly leaseMs: number;

  constructor(
    private readonly alarmRepository: AlarmRepository,
    private readonly recipientRepository: AlarmRecipientRepository,
    @Inject(SEND_CLIENT) private readonly client: SendClient,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    config: ConfigService<Configuration, true>,
  ) {
    const worker = config.get('worker', { infer: true });
    this.maxAttempts = worker.maxAttempts;
    this.leaseMs = worker.leaseSec * 1000;
  }

  async handle(data: SendJobData): Promise<SendOutcome> {
    const { alarmId, recipientId } = data;
    const row = await this.recipientRepository.findOne(alarmId, recipientId);
    if (!row) return { action: 'done', reason: 'row_missing' };

    switch (row.status) {
      case RecipientStatus.PENDING: {
        // 1. claim — 알림이 취소됐으면 실패하고 잡은 그대로 끝난다 (토큰도 쓰지 않는다)
        const claimed = await this.recipientRepository.claim(alarmId, recipientId, this.leaseUntil());
        if (!claimed) return { action: 'done', reason: 'claim_rejected' };
        const alarm = await this.alarmRepository.findById(alarmId);
        if (!alarm) return { action: 'done', reason: 'alarm_missing' };
        return this.callAndSettle(alarm, row);
      }
      case RecipientStatus.UNKNOWN:
      case RecipientStatus.PROCESSING:
        return this.reconcile(alarmId, recipientId, row);
      default:
        // SENT / FAILED / CANCELLED — 이미 끝난 건. 재전달된 잡은 조용히 종료
        return { action: 'done', reason: `already_${row.status.toLowerCase()}` };
    }
  }

  // 2. call → 3. settle
  private async callAndSettle(alarm: Alarm, row: AlarmRecipient): Promise<SendOutcome> {
    const clientRef = AlarmRecipient.clientRef(alarm.id, row.recipientId);
    await this.limiter.acquire();
    const result = await this.client.send({
      alarmId: alarm.id,
      recipientId: row.recipientId,
      title: alarm.title,
      body: alarm.body,
      clientRef,
    });
    return this.settle(alarm.id, row, result);
  }

  private async settle(alarmId: string, row: AlarmRecipient, result: SendResult): Promise<SendOutcome> {
    const { recipientId } = row;
    switch (result.kind) {
      case 'sent':
        await this.recipientRepository.settle(alarmId, recipientId, {
          status: RecipientStatus.SENT,
          messageId: result.messageId,
          sentAt: new Date(),
          lastError: null,
        });
        await this.completeIfSettled(alarmId);
        return { action: 'done', reason: 'sent' };

      case 'permanent':
        await this.recipientRepository.settle(alarmId, recipientId, {
          status: RecipientStatus.FAILED,
          lastError: result.code,
        });
        await this.completeIfSettled(alarmId);
        this.logger.warn(`[영구 실패] alarm=${alarmId} recipient=${recipientId} code=${result.code}`);
        return { action: 'done', reason: 'permanent_failure' };

      case 'rate_limited':
        // 보내지지 않았다. 시도 횟수를 세지 않고 PENDING 으로 되돌린 뒤 큐 전체를 멈춘다
        await this.recipientRepository.settle(alarmId, recipientId, { status: RecipientStatus.PENDING });
        this.logger.warn(`[429] alarm=${alarmId} recipient=${recipientId} retryAfterMs=${result.retryAfterMs}`);
        return { action: 'rate_limited', retryAfterMs: result.retryAfterMs };

      case 'temporary':
      case 'network': {
        const attemptCount = row.attemptCount + 1;
        if (attemptCount >= this.maxAttempts) {
          await this.recipientRepository.settle(alarmId, recipientId, {
            status: RecipientStatus.FAILED,
            attemptCount,
            lastError: result.code,
          });
          await this.completeIfSettled(alarmId);
          this.logger.warn(
            `[재시도 소진] alarm=${alarmId} recipient=${recipientId} attempts=${attemptCount} code=${result.code}`,
          );
          return { action: 'done', reason: 'attempts_exhausted' };
        }
        await this.recipientRepository.settle(alarmId, recipientId, {
          status: RecipientStatus.PENDING,
          attemptCount,
          lastError: result.code,
        });
        return { action: 'retry', delayMs: this.backoffMs(attemptCount), reason: `temporary_${result.code}` };
      }

      case 'timeout':
        // 발송됐을 수 있다. 재전송하지 않고 UNKNOWN 으로 둔 뒤 잠시 후 clientRef 로 확인한다
        await this.recipientRepository.settle(alarmId, recipientId, {
          status: RecipientStatus.UNKNOWN,
          lastError: 'TIMEOUT',
        });
        this.logger.warn(`[타임아웃] alarm=${alarmId} recipient=${recipientId} → UNKNOWN, 조회 예정`);
        return { action: 'retry', delayMs: RECONCILE_DELAY_MS, reason: 'timeout' };
    }
  }

  /**
   * 결과 확인. UNKNOWN(타임아웃) 또는 lease 가 만료된 PROCESSING(워커 사망) 건을 다시 점유하고
   * mock 에 clientRef 로 물어본다. 있으면 SENT, 없으면 알림이 살아 있을 때만 재발송(없으면 CANCELLED).
   */
  private async reconcile(alarmId: string, recipientId: string, row: AlarmRecipient): Promise<SendOutcome> {
    const reclaimed = await this.recipientRepository.reclaimForReconcile(alarmId, recipientId, this.leaseUntil());
    if (!reclaimed) {
      // PROCESSING 인데 lease 가 살아 있다 = 다른 워커가 처리 중. 잠시 후 다시 본다
      return { action: 'retry', delayMs: this.leaseMs, reason: 'processing_elsewhere' };
    }

    await this.limiter.acquire();
    let messageId: string | null;
    try {
      messageId = await this.client.findMessageIdByClientRef(AlarmRecipient.clientRef(alarmId, recipientId));
    } catch (error) {
      // 조회 자체가 실패하면 UNKNOWN 으로 돌려놓고 다음에 다시
      await this.recipientRepository.settle(alarmId, recipientId, { status: RecipientStatus.UNKNOWN });
      return { action: 'retry', delayMs: RECONCILE_DELAY_MS, reason: `reconcile_failed_${(error as Error).name}` };
    }

    if (messageId) {
      await this.recipientRepository.settle(alarmId, recipientId, {
        status: RecipientStatus.SENT,
        messageId,
        sentAt: new Date(),
        lastError: null,
      });
      await this.completeIfSettled(alarmId);
      this.logger.log(`[조회로 확정] alarm=${alarmId} recipient=${recipientId} messageId=${messageId}`);
      return { action: 'done', reason: 'reconciled_sent' };
    }

    const alarm = await this.alarmRepository.findById(alarmId);
    if (!alarm || alarm.status === AlarmStatus.CANCELLED || alarm.status === AlarmStatus.COMPLETED) {
      await this.recipientRepository.settle(alarmId, recipientId, { status: RecipientStatus.CANCELLED });
      return { action: 'done', reason: 'reconciled_cancelled' };
    }
    // 보내지지 않았음이 확인됐으므로 이번엔 실제로 보낸다
    return this.callAndSettle(alarm, row);
  }

  // 미종결 수신자가 없으면 SENDING → COMPLETED. 마지막 두 건이 동시에 와도 조건부 UPDATE 는 한 번만 성공한다
  private async completeIfSettled(alarmId: string): Promise<void> {
    if (await this.recipientRepository.hasUnsettled(alarmId)) return;
    const completed = await this.alarmRepository.transition(alarmId, [AlarmStatus.SENDING], AlarmStatus.COMPLETED);
    if (completed) this.logger.log(`[발송 완료] alarm=${alarmId}`);
  }

  private leaseUntil(): Date {
    return new Date(Date.now() + this.leaseMs);
  }

  private backoffMs(attempt: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
}
