import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../../common/config/configuration';
import { Alarm } from '../alarm/alarm.entity';
import { AlarmRepository } from '../alarm/alarm.repository';
import { AlarmRecipient } from '../alarm/alarm-recipient.entity';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { RecipientStatus } from '../alarm/recipient-status.enum';
import { SendJobData } from './dispatch-job';
import { RATE_LIMITER, RateLimiter } from './rate-limiter';
import { SEND_CLIENT, SendClient, SendResult } from './send-client';

// 잡 종료 사유 (로그·테스트에서 그대로 쓴다). code 에는 외부 오류 코드 등 부가 정보만 담는다
export type SendReason =
  | 'sent'
  | 'row_missing'
  | 'claim_rejected'
  | 'alarm_missing'
  | 'already_settled'
  | 'permanent_failure'
  | 'attempts_exhausted'
  | 'temporary_failure'
  | 'timeout'
  | 'lease_expired'
  | 'processing_elsewhere'
  | 'reconcile_failed'
  | 'reconciled_sent'
  | 'reconciled_cancelled'
  | 'rate_limited';

// 잡 처리 결과. 프로세서가 BullMQ 동작(완료 / 지연 재투입)으로 옮긴다
export type SendOutcome =
  | { action: 'done'; reason: SendReason; code?: string }
  | { action: 'retry'; delayMs: number; reason: SendReason; code?: string };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// 요청이 서버에 닿지 않았다고 확신할 수 있는 네트워크 오류. 그 외(소켓 끊김 등)는 처리됐을 수 있으므로 타임아웃과 같게 다룬다
const SAFE_TO_RETRY_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);
// 발송 직전 lease 가 이만큼도 안 남았으면 보내지 않는다 (다른 워커가 곧 reclaim 하므로 중복 위험)
const LEASE_SAFETY_MARGIN_MS = 5_000;

/**
 * 수신자 1명 발송: claim(조건부 UPDATE) → call(트랜잭션 밖, 토큰 버킷) → settle(조건부 UPDATE).
 * 상태의 진실은 DB 행이다. 잡이 몇 번 재전달되든 행 상태를 보고 할 일을 정하므로 중복 발송이 없다.
 * claim 때 받은 lease_until 이 펜스다: settle 은 같은 값일 때만 기록되고, lease 가 만료된 실행은 보내지도 기록하지도 않는다.
 */
@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  // 타임아웃 뒤 clientRef 조회까지 기다리는 시간. mock 은 요청 수신 시점에 기록하므로 짧아도 되지만 서버 지연을 감안해 둔다
  private readonly reconcileDelayMs: number;

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
    this.reconcileDelayMs = worker.reconcileDelayMs;
  }

  async handle(data: SendJobData): Promise<SendOutcome> {
    const { alarmId, recipientId } = data;
    const row = await this.recipientRepository.findOne(alarmId, recipientId);
    if (!row) return { action: 'done', reason: 'row_missing' };

    switch (row.status) {
      case RecipientStatus.PENDING: {
        // 1. claim — 알림이 취소됐으면 실패하고 잡은 그대로 끝난다 (토큰도 쓰지 않는다)
        const fence = this.newLease();
        const claimed = await this.recipientRepository.claim(alarmId, recipientId, fence);
        if (!claimed) return this.rejectClaim(alarmId, recipientId);
        const alarm = await this.alarmRepository.findById(alarmId);
        if (!alarm) return { action: 'done', reason: 'alarm_missing' };
        return this.callAndSettle(alarm, row, fence);
      }
      case RecipientStatus.UNKNOWN:
      case RecipientStatus.PROCESSING:
        return this.reconcile(alarmId, recipientId, row);
      default:
        // SENT / FAILED / CANCELLED — 이미 끝난 건. 재전달된 잡은 조용히 종료
        return { action: 'done', reason: 'already_settled', code: row.status };
    }
  }

  // claim 거절 = 알림이 종료됐거나 다른 실행이 먼저 잡았다. 종료된 알림의 PENDING 잔여 행은 여기서 CANCELLED 로 정리한다
  private async rejectClaim(alarmId: string, recipientId: string): Promise<SendOutcome> {
    const alarm = await this.alarmRepository.findById(alarmId);
    if (!alarm || alarm.status === AlarmStatus.CANCELLED || alarm.status === AlarmStatus.COMPLETED) {
      await this.recipientRepository.cancelIfPending(alarmId, recipientId);
    }
    return { action: 'done', reason: 'claim_rejected', code: alarm?.status };
  }

  // 2. call → 3. settle
  private async callAndSettle(alarm: Alarm, row: AlarmRecipient, fence: Date): Promise<SendOutcome> {
    const clientRef = AlarmRecipient.clientRef(alarm.id, row.recipientId);
    await this.limiter.acquire();
    // 토큰을 기다리는 동안 lease 가 거의 만료됐으면 보내지 않는다 — 곧 다른 워커가 reclaim 해 결과를 확인할 것이므로 중복을 피한다
    if (Date.now() > fence.getTime() - LEASE_SAFETY_MARGIN_MS) {
      this.logger.warn(`[lease 만료] alarmId=${alarm.id} recipientId=${row.recipientId} → 발송 생략, 다음 실행이 확인`);
      return { action: 'retry', delayMs: LEASE_SAFETY_MARGIN_MS, reason: 'lease_expired' };
    }
    const result = await this.client.send({
      alarmId: alarm.id,
      recipientId: row.recipientId,
      title: alarm.title,
      body: alarm.body,
      clientRef,
    });
    return this.settle(alarm.id, row, fence, result);
  }

  private async settle(alarmId: string, row: AlarmRecipient, fence: Date, result: SendResult): Promise<SendOutcome> {
    const { recipientId } = row;
    const write = (patch: Parameters<AlarmRecipientRepository['settle']>[3]) =>
      this.recipientRepository.settle(alarmId, recipientId, fence, patch);

    switch (result.kind) {
      case 'sent':
        if (
          await write({
            status: RecipientStatus.SENT,
            messageId: result.messageId,
            sentAt: new Date(),
            lastError: null,
          })
        ) {
          await this.completeIfSettled(alarmId);
        }
        return { action: 'done', reason: 'sent' };

      case 'permanent':
        if (await write({ status: RecipientStatus.FAILED, lastError: result.code }))
          await this.completeIfSettled(alarmId);
        this.logger.warn(`[영구 실패] alarmId=${alarmId} recipientId=${recipientId} code=${result.code}`);
        return { action: 'done', reason: 'permanent_failure', code: result.code };

      case 'rate_limited':
        // 보내지지 않았다. 시도 횟수를 세지 않고 PENDING 으로 되돌리고, 모든 워커의 호출을 Retry-After 만큼 멈춘다
        await write({ status: RecipientStatus.PENDING });
        await this.limiter.pause(result.retryAfterMs);
        this.logger.warn(
          `[429] alarmId=${alarmId} recipientId=${recipientId} retryAfterMs=${result.retryAfterMs} → 전역 일시정지`,
        );
        return { action: 'retry', delayMs: result.retryAfterMs, reason: 'rate_limited' };

      case 'network':
        if (!SAFE_TO_RETRY_NETWORK_CODES.has(result.code)) {
          // 소켓이 끊긴 경우 서버가 처리했을 수 있다 → 타임아웃과 같이 조회로 확정한다
          await write({ status: RecipientStatus.UNKNOWN, lastError: result.code });
          this.logger.warn(
            `[네트워크 오류] alarmId=${alarmId} recipientId=${recipientId} code=${result.code} → UNKNOWN, 조회 예정`,
          );
          return { action: 'retry', delayMs: this.reconcileDelayMs, reason: 'timeout', code: result.code };
        }
        return this.retryOrFail(alarmId, row, fence, result.code);

      case 'temporary':
        return this.retryOrFail(alarmId, row, fence, result.code);

      case 'timeout':
        // 발송됐을 수 있다. 재전송하지 않고 UNKNOWN 으로 둔 뒤 잠시 후 clientRef 로 확인한다
        await write({ status: RecipientStatus.UNKNOWN, lastError: 'TIMEOUT' });
        this.logger.warn(
          `[타임아웃] alarmId=${alarmId} recipientId=${recipientId} → UNKNOWN, ${this.reconcileDelayMs}ms 뒤 조회`,
        );
        return { action: 'retry', delayMs: this.reconcileDelayMs, reason: 'timeout' };
    }
  }

  // 5xx·연결 거부: 보내지지 않았으므로 백오프 재시도, 상한에 닿으면 영구 실패
  private async retryOrFail(alarmId: string, row: AlarmRecipient, fence: Date, code: string): Promise<SendOutcome> {
    const attemptCount = row.attemptCount + 1;
    if (attemptCount >= this.maxAttempts) {
      const written = await this.recipientRepository.settle(alarmId, row.recipientId, fence, {
        status: RecipientStatus.FAILED,
        attemptCount,
        lastError: code,
      });
      if (written) await this.completeIfSettled(alarmId);
      this.logger.warn(
        `[재시도 소진] alarmId=${alarmId} recipientId=${row.recipientId} attempts=${attemptCount} code=${code}`,
      );
      return { action: 'done', reason: 'attempts_exhausted', code };
    }
    await this.recipientRepository.settle(alarmId, row.recipientId, fence, {
      status: RecipientStatus.PENDING,
      attemptCount,
      lastError: code,
    });
    return { action: 'retry', delayMs: this.backoffMs(attemptCount), reason: 'temporary_failure', code };
  }

  /**
   * 결과 확인. UNKNOWN(타임아웃) 또는 lease 가 만료된 PROCESSING(워커 사망) 건을 다시 점유하고
   * mock 에 clientRef 로 물어본다. 있으면 SENT, 없으면 알림이 살아 있을 때만 재발송(없으면 CANCELLED).
   */
  private async reconcile(alarmId: string, recipientId: string, row: AlarmRecipient): Promise<SendOutcome> {
    const fence = this.newLease();
    const reclaimed = await this.recipientRepository.reclaimForReconcile(alarmId, recipientId, fence);
    if (!reclaimed) {
      // PROCESSING 인데 lease 가 살아 있다 = 다른 워커가 처리 중. lease 가 끝날 때쯤 다시 본다
      return { action: 'retry', delayMs: this.leaseMs, reason: 'processing_elsewhere' };
    }

    // 처리량 제한은 POST /v1/messages 에만 적용되므로(mock 문서) 조회는 토큰 없이 바로 한다
    let messageId: string | null;
    try {
      messageId = await this.client.findMessageIdByClientRef(AlarmRecipient.clientRef(alarmId, recipientId));
    } catch (error) {
      // 조회 자체가 실패하면 UNKNOWN 으로 돌려놓고 다음에 다시
      await this.recipientRepository.settle(alarmId, recipientId, fence, { status: RecipientStatus.UNKNOWN });
      const code = error instanceof Error ? error.name : String(error);
      return { action: 'retry', delayMs: this.reconcileDelayMs, reason: 'reconcile_failed', code };
    }

    if (messageId) {
      const written = await this.recipientRepository.settle(alarmId, recipientId, fence, {
        status: RecipientStatus.SENT,
        messageId,
        sentAt: new Date(),
        lastError: null,
      });
      if (written) await this.completeIfSettled(alarmId);
      this.logger.log(`[조회로 확정] alarmId=${alarmId} recipientId=${recipientId} messageId=${messageId}`);
      return { action: 'done', reason: 'reconciled_sent' };
    }

    const alarm = await this.alarmRepository.findById(alarmId);
    if (!alarm || alarm.status === AlarmStatus.CANCELLED || alarm.status === AlarmStatus.COMPLETED) {
      await this.recipientRepository.settle(alarmId, recipientId, fence, { status: RecipientStatus.CANCELLED });
      return { action: 'done', reason: 'reconciled_cancelled' };
    }
    // 보내지지 않았음이 확인됐으므로 이번엔 실제로 보낸다 (같은 펜스로)
    return this.callAndSettle(alarm, row, fence);
  }

  // 미종결 수신자가 없으면 SENDING → COMPLETED. 마지막 두 건이 동시에 와도 조건부 UPDATE 는 한 번만 성공한다
  private async completeIfSettled(alarmId: string): Promise<void> {
    if (await this.recipientRepository.hasUnsettled(alarmId)) return;
    const completed = await this.alarmRepository.transition(alarmId, [AlarmStatus.SENDING], AlarmStatus.COMPLETED);
    if (completed) this.logger.log(`[발송 완료] alarmId=${alarmId}`);
  }

  private newLease(): Date {
    return new Date(Date.now() + this.leaseMs);
  }

  private backoffMs(attempt: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
}
