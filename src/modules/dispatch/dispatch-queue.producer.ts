import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AlarmType } from '../alarm/alarm-type.enum';
import {
  DISPATCH_QUEUE,
  DispatchJobName,
  JOB_PRIORITY,
  PrepareJobData,
  prepareJobId,
  retryPriority,
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

  /**
   * 복구용 재투입. 잡이 큐에 없으면 새로 넣고, 대기 중이면 우선순위를 올려 앞으로 당긴다
   * (같은 jobId 가 큐에 있으면 add 는 무시되므로, 뒤에 줄 선 잡은 끌어올려야 실제로 복구된다). 처리 중/지연 중인 잡은 건드리지 않는다
   */
  async requeueOrPromote(
    alarmId: string,
    type: AlarmType,
    recipientIds: string[],
  ): Promise<{ added: number; promoted: number }> {
    const missing: string[] = [];
    let promoted = 0;
    for (const recipientId of recipientIds) {
      const job: Job | undefined = await this.queue.getJob(sendJobId(alarmId, recipientId));
      if (!job) {
        missing.push(recipientId);
        continue;
      }
      const state: string = await job.getState();
      if (state === 'prioritized' || state === 'waiting') {
        const priority = retryPriority(job.opts.priority);
        if (priority !== job.opts.priority) {
          await job.changePriority({ priority });
          promoted += 1;
        }
      }
    }
    await this.enqueueSendBatch(alarmId, type, missing);
    return { added: missing.length, promoted };
  }
}
