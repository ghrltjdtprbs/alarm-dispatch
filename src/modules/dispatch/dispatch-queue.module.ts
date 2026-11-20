import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { DISPATCH_QUEUE } from './dispatch-job';
import { DispatchQueueProducer } from './dispatch-queue.producer';

const INFRA_ATTEMPTS = 3;
const INFRA_BACKOFF_MS = 2_000;

/**
 * 발송 큐 등록 + producer. ApiModule(발송 시작) 과 WorkerModule 이 함께 import 한다.
 * 완료/실패 잡은 Redis 에 남기지 않는다 — 상태의 진실은 DB(alarm_recipients) 이고, 실패 잡이 남아 있으면 같은 jobId 재투입이 막혀 복구 스윕이 동작하지 않는다
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: DISPATCH_QUEUE,
      // attempts/backoff 는 인프라 예외(DB·Redis 끊김)용. 발송 재시도 횟수는 DB 행이 관리한다
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: INFRA_ATTEMPTS,
        backoff: { type: 'exponential', delay: INFRA_BACKOFF_MS },
      },
    }),
  ],
  providers: [DispatchQueueProducer],
  exports: [BullModule, DispatchQueueProducer],
})
export class DispatchQueueModule {}
