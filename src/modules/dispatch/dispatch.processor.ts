import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import { Configuration } from '../../common/config/configuration';
import { DISPATCH_QUEUE, DispatchJobName, PrepareJobData, SendJobData } from './dispatch-job';
import { PrepareService } from './prepare.service';
import { SendService } from './send.service';

/**
 * 발송 큐 소비자 (워커 프로세스 전용).
 * - 잡 실패 시 BullMQ 재시도는 인프라 오류(DB 끊김 등) 용이고, 발송 재시도 횟수는 DB 행(attempt_count) 이 관리한다
 * - stalled: 워커가 죽어 lock 갱신이 끊긴 잡은 stalledInterval 뒤 다른 워커가 다시 받는다 (maxStalledCount 번까지)
 */
@Processor(DISPATCH_QUEUE, { lockDuration: 30_000, stalledInterval: 15_000, maxStalledCount: 3 })
export class DispatchProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DispatchProcessor.name);
  private readonly concurrency: number;

  constructor(
    private readonly sendService: SendService,
    private readonly prepareService: PrepareService,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
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
    switch (outcome.action) {
      case 'done':
        // 정상 발송(sent) 은 10만 건이라 남기지 않는다. 그 외 종료 사유만 기록
        if (outcome.reason !== 'sent') this.logger.log(`[send 종료] id=${job.id} reason=${outcome.reason}`);
        return;
      case 'retry':
        // 시도 횟수를 소모하지 않고 지정 시간 뒤 다시 처리한다 (BullMQ 공식 패턴: moveToDelayed + DelayedError)
        await job.moveToDelayed(Date.now() + outcome.delayMs, token);
        throw new DelayedError();
      case 'rate_limited':
        // 큐 전체(모든 워커) 를 Retry-After 만큼 멈춘다. 잡은 시도 차감 없이 대기열로 돌아간다
        await this.queue.rateLimit(outcome.retryAfterMs);
        throw Worker.RateLimitError();
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    // DelayedError/RateLimitError 는 정상 흐름이라 여기 오지 않는다. 남는 건 예기치 못한 예외 → 복구 스윕이 행 상태로 되살린다
    this.logger.error(`[잡 실패] name=${job?.name} id=${job?.id} attempts=${job?.attemptsMade}`, error.stack);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`[워커 오류] ${error.message}`, error.stack);
  }
}
