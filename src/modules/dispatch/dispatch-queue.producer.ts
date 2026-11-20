import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AlarmType } from '../alarm/alarm-type.enum';
import {
  DISPATCH_QUEUE,
  DispatchJobName,
  JOB_PRIORITY,
  PrepareJobData,
  prepareJobId,
  SendJobData,
  sendJobId,
} from './dispatch-job';

// 큐 투입 전담. API(발송 시작) 와 워커(prepare → send 잡 투입, 복구 스윕) 양쪽이 쓴다. 소비는 워커 전용 모듈에서만
@Injectable()
export class DispatchQueueProducer {
  constructor(@InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue) {}

  async enqueuePrepare(alarmId: string, type: AlarmType): Promise<void> {
    const data: PrepareJobData = { alarmId, type };
    await this.queue.add(DispatchJobName.PREPARE, data, {
      jobId: prepareJobId(alarmId),
      priority: JOB_PRIORITY[type].prepare,
    });
  }

  // 수신자 묶음을 한 번에 투입. jobId 가 결정적이라 재실행해도 중복 투입되지 않는다
  async enqueueSendBatch(alarmId: string, type: AlarmType, recipientIds: string[]): Promise<void> {
    if (recipientIds.length === 0) return;
    await this.queue.addBulk(
      recipientIds.map((recipientId) => ({
        name: DispatchJobName.SEND,
        data: { alarmId, recipientId } satisfies SendJobData,
        opts: { jobId: sendJobId(alarmId, recipientId), priority: JOB_PRIORITY[type].send },
      })),
    );
  }
}
