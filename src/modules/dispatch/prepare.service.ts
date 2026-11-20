import { Inject, Injectable, Logger } from '@nestjs/common';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { AlarmRepository } from '../alarm/alarm.repository';
import { PrepareJobData } from './dispatch-job';
import { DispatchQueueProducer } from './dispatch-queue.producer';
import { SEND_CLIENT, SendClient } from './send-client';

// mock 사용자 API 최대 limit. 10만 명 = 100 페이지
const USER_PAGE_SIZE = 1000;

/**
 * prepare 잡: 수신자를 적재하고 send 잡을 투입한 뒤 PREPARING → SENDING.
 * 모든 단계가 재실행 안전하다 — insert 는 유니크 충돌 무시, 잡은 jobId 로 중복 무시 — 그래서 중간에 워커가 죽어 다시 돌아도 괜찮다.
 */
@Injectable()
export class PrepareService {
  private readonly logger = new Logger(PrepareService.name);

  constructor(
    private readonly alarmRepository: AlarmRepository,
    private readonly recipientRepository: AlarmRecipientRepository,
    private readonly producer: DispatchQueueProducer,
    @Inject(SEND_CLIENT) private readonly client: SendClient,
  ) {}

  async handle(data: PrepareJobData): Promise<void> {
    const alarm = await this.alarmRepository.findById(data.alarmId);
    if (!alarm || alarm.status !== AlarmStatus.PREPARING) {
      this.logger.warn(`[prepare 건너뜀] alarm=${data.alarmId} status=${alarm?.status ?? 'missing'}`);
      return;
    }

    const enqueued =
      alarm.type === AlarmType.URGENT
        ? await this.enqueueStoredRecipients(alarm.id)
        : await this.loadAndEnqueueAllUsers(alarm.id);

    // 적재 중 취소됐으면 뒤늦게 들어간 PENDING 행을 마저 취소하고 끝낸다
    const moved = await this.alarmRepository.transition(alarm.id, [AlarmStatus.PREPARING], AlarmStatus.SENDING);
    if (!moved) {
      const cancelled = await this.recipientRepository.cancelPending(alarm.id);
      this.logger.warn(`[prepare 중 취소] alarm=${alarm.id} enqueued=${enqueued} cancelledPending=${cancelled}`);
      return;
    }
    this.logger.log(`[prepare 완료] alarm=${alarm.id} type=${alarm.type} enqueued=${enqueued} → SENDING`);

    // 수신자가 0명이거나 이미 전부 처리된 경우를 위해 완료 판정 한 번
    if (!(await this.recipientRepository.hasUnsettled(alarm.id))) {
      await this.alarmRepository.transition(alarm.id, [AlarmStatus.SENDING], AlarmStatus.COMPLETED);
    }
  }

  // 긴급: 생성 시 적재된 수신자(≤100)로 send 잡만 투입
  private async enqueueStoredRecipients(alarmId: string): Promise<number> {
    let afterId: string | null = null;
    let total = 0;
    for (;;) {
      const page = await this.recipientRepository.findRecipientIds(alarmId, afterId, USER_PAGE_SIZE);
      if (page.length === 0) return total;
      await this.producer.enqueueSendBatch(
        alarmId,
        AlarmType.URGENT,
        page.map((r) => r.recipientId),
      );
      total += page.length;
      afterId = page[page.length - 1].id;
    }
  }

  // 대량: mock 사용자 API 를 커서로 끝까지 읽으며 페이지마다 적재 + 투입. 투입을 페이지 단위로 하면 적재가 끝나기 전부터 발송이 시작된다
  private async loadAndEnqueueAllUsers(alarmId: string): Promise<number> {
    let cursor: string | null = null;
    let total = 0;
    do {
      const page = await this.client.listUsers(cursor, USER_PAGE_SIZE);
      await this.recipientRepository.insertPendingIgnoreDuplicates(alarmId, page.ids);
      await this.producer.enqueueSendBatch(alarmId, AlarmType.BULK, page.ids);
      total += page.ids.length;
      cursor = page.nextCursor;

      // 페이지마다 취소 여부 확인 — 취소됐으면 더 읽지 않는다
      const alarm = await this.alarmRepository.findById(alarmId);
      if (alarm?.status !== AlarmStatus.PREPARING) break;
    } while (cursor);
    return total;
  }
}
