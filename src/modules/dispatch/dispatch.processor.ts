import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';

import { Configuration } from '../../common/config/configuration';
import { DISPATCH_QUEUE, DispatchJobName, PrepareJobData, retryPriority, SendJobData } from './dispatch-job';
import { PrepareService } from './prepare.service';
import { SendReason, SendService } from './send.service';

// 잡 lock 유지 시간(워커가 자동 연장). 끊긴 뒤 stalledInterval 마다 검사해 다른 워커가 받는다. 한 잡이 maxStalledCount 번 stalled 되면 실패 처리
const LOCK_DURATION_MS = 30_000;
const STALLED_INTERVAL_MS = 15_000;
const MAX_STALLED_COUNT = 3;
// 10만 건 단위로 반복되는 정상 종료 사유는 로그에 남기지 않는다 (취소된 알림의 no-op 잡이 한꺼번에 빠질 때 로그 폭주 방지)
const QUIET_REASONS: ReadonlySet<SendReason> = new Set<SendReason>(['sent', 'claim_rejected', 'already_settled']);

/**
 * 발송 큐 소비자 (워커 프로세스 전용).
 * - 잡 실패 시 BullMQ 재시도는 인프라 오류(DB 끊김 등) 용이고, 발송 재시도 횟수는 DB 행(attempt_count) 이 관리한다
 * - stalled: 워커가 죽어 lock 갱신이 끊긴 잡은 stalledInterval 뒤 다른 워커가 다시 받는다 (maxStalledCount 번까지)
 * - 종료: onModuleDestroy 에서 worker.close() 로 진행 중 잡을 끝내고 나서야 다른 연결(Redis 토큰 버킷 등) 이 닫힌다
 */
@Processor(DISPATCH_QUEUE, {
  lockDuration: LOCK_DURATION_MS,
  stalledInterval: STALLED_INTERVAL_MS,
  maxStalledCount: MAX_STALLED_COUNT,
})
export class DispatchProcessor extends WorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchProcessor.name);
  private readonly concurrency: number;

  constructor(
    private readonly sendService: SendService,
    private readonly prepareService: PrepareService,
    config: ConfigService<Configuration, true>,
  ) {
    super();
    this.concurrency = config.get('worker', { infer: true }).concurrency;
  }

  // 데코레이터 옵션은 정적이라 설정값 동시성은 기동 후 지정한다
  onModuleInit(): void {
    this.worker.concurrency = this.concurrency;
    this.logger.log(`[워커 준비] queue=${DISPATCH_QUEUE} concurrency=${this.concurrency}`);
  }

  // SIGTERM: 새 잡을 받지 않고 진행 중 잡이 끝날 때까지 기다린다. 그 뒤 Nest 가 onApplicationShutdown 으로 나머지 연결을 닫는다
  async onModuleDestroy(): Promise<void> {
    this.logger.log(`[워커 종료 시작] 진행 중 잡 완료 대기`);
    await this.worker.close();
    this.logger.log(`[워커 종료 완료]`);
  }

  async process(job: Job, token?: string): Promise<void> {
    const name = job.name as DispatchJobName;
    if (name === DispatchJobName.PREPARE) {
      await this.prepareService.handle(job.data as PrepareJobData);
      return;
    }
    if (name !== DispatchJobName.SEND) {
      this.logger.warn(`[알 수 없는 잡] name=${job.name} id=${job.id}`);
      return;
    }

    const outcome = await this.sendService.handle(job.data as SendJobData);
    if (outcome.action === 'done') {
      if (!QUIET_REASONS.has(outcome.reason)) {
        this.logger.log(
          `[send 종료] jobId=${job.id} reason=${outcome.reason}${outcome.code ? ` code=${outcome.code}` : ''}`,
        );
      }
      return;
    }
    // 시도 횟수를 소모하지 않고 지정 시간 뒤 다시 처리한다 (BullMQ 공식 패턴: moveToDelayed + DelayedError).
    // 복귀 시 대량 잡 뒤에 줄 서지 않도록 우선순위를 먼저 올린다 (active 잡은 해시 값만 바뀌고 승격 때 반영된다).
    // job.priority 는 changePriority 가 갱신하지만 job.opts.priority 는 원래 값이라 전자를 본다
    const priority = retryPriority(job.priority);
    if (priority !== job.priority) await job.changePriority({ priority });
    await job.moveToDelayed(Date.now() + outcome.delayMs, token);
    throw new DelayedError();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    // DelayedError 는 정상 흐름이라 여기 오지 않는다. 남는 건 예기치 못한 예외(DB·Redis 끊김 등) → BullMQ 가 attempts 만큼 재시도하고,
    // 그래도 실패하면 잡은 제거되고(removeOnFail) 복구 스윕이 DB 행 상태를 보고 다시 투입한다
    this.logger.error(`[잡 실패] name=${job?.name} id=${job?.id} attempts=${job?.attemptsMade}`, error.stack);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`[워커 오류] ${error.message}`, error.stack);
  }
}
