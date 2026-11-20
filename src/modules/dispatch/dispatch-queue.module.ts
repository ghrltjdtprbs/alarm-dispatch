import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DISPATCH_QUEUE } from './dispatch-job';
import { DispatchQueueProducer } from './dispatch-queue.producer';

/**
 * 발송 큐 등록 + producer. ApiModule(발송 시작) 과 WorkerModule 이 함께 import 한다.
 * 완료/실패 잡은 Redis 에 남기지 않는다 — 상태의 진실은 DB(alarm_recipients) 이고, 10만 잡의 이력을 Redis 에 쌓으면 메모리만 먹는다
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: DISPATCH_QUEUE,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000 },
    }),
  ],
  providers: [DispatchQueueProducer],
  exports: [BullModule, DispatchQueueProducer],
})
export class DispatchQueueModule {}
