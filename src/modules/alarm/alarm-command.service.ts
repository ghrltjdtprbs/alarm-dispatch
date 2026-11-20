import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DispatchQueueProducer } from '../dispatch/dispatch-queue.producer';
import { Alarm } from './alarm.entity';
import { AlarmInvalidStatusException, AlarmRecipientsInvalidException } from './alarm.exception';
import { AlarmRepository } from './alarm.repository';
import { AlarmQueryService } from './alarm-query.service';
import { AlarmRecipientRepository } from './alarm-recipient.repository';
import { ALARM_TRANSITIONS, AlarmStatus } from './alarm-status.enum';
import { AlarmType, URGENT_MAX_RECIPIENTS } from './alarm-type.enum';
import { AlarmResponse } from './dto/alarm.response';
import { CreateAlarmRequest } from './dto/create-alarm.request';

/** 상태 변경 전용 (생성·발송 시작·취소). 외부 발송 호출은 하지 않는다 — 워커의 일. */
@Injectable()
export class AlarmCommandService {
  private readonly logger = new Logger(AlarmCommandService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly alarmRepository: AlarmRepository,
    private readonly recipientRepository: AlarmRecipientRepository,
    private readonly queryService: AlarmQueryService,
    private readonly dispatchQueue: DispatchQueueProducer,
  ) {}

  async create(request: CreateAlarmRequest): Promise<AlarmResponse> {
    const recipientIds = this.validateRecipients(request.type, request.recipientIds);

    // 긴급 알림은 수신자가 요청에 있으므로 생성과 같은 트랜잭션에서 적재한다 (대량은 발송 시작 시 워커가 mock 사용자 API 로 적재)
    const alarm = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(Alarm.create(request.type, request.title, request.body));
      await this.recipientRepository.insertPendingIgnoreDuplicates(saved.id, recipientIds, manager);
      return saved;
    });
    this.logger.log(`[알림 생성] alarmId=${alarm.id} type=${alarm.type} recipients=${recipientIds.length}`);
    return AlarmResponse.from(alarm);
  }

  /**
   * 발송 시작. CREATED → PREPARING 조건부 전이에 성공한 요청만 큐에 prepare 잡을 넣는다.
   * 동시에 여러 번 눌러도 UPDATE 는 한 건만 성공하므로 잡도 하나만 들어간다.
   */
  async startSend(id: string): Promise<AlarmResponse> {
    const moved = await this.alarmRepository.transition(
      id,
      ALARM_TRANSITIONS[AlarmStatus.PREPARING],
      AlarmStatus.PREPARING,
    );
    // 전이 뒤에 읽어야 404(없음) 와 409(상태 불가) 를 구분하면서 갱신된 updatedAt 을 돌려줄 수 있다
    const alarm = await this.queryService.getEntityOrThrow(id);
    if (!moved) throw new AlarmInvalidStatusException(alarm.status, '발송 시작');

    try {
      await this.dispatchQueue.enqueuePrepare(alarm.id, alarm.type);
    } catch (error) {
      // 큐 투입 실패 시 되돌려서 다시 시도할 수 있게 한다 (워커 복구 스윕도 PREPARING 고아를 다시 투입한다)
      await this.alarmRepository.transition(id, [AlarmStatus.PREPARING], AlarmStatus.CREATED);
      throw error;
    }
    this.logger.log(`[발송 시작] alarmId=${id} type=${alarm.type}`);
    return AlarmResponse.from(alarm);
  }

  /**
   * 취소. 알림 상태 전이와 PENDING 수신자 일괄 취소를 한 트랜잭션으로 묶는다 (둘 다 manager 로 실행).
   * 워커는 claim 때 알림 상태를 다시 확인하므로 이후 잡은 발송하지 않고 끝난다. 이미 보낸 건은 SENT 로 남는다.
   */
  async cancel(id: string): Promise<AlarmResponse> {
    const { moved, cancelledPending } = await this.dataSource.transaction(async (manager) => {
      const ok = await this.alarmRepository.transition(
        id,
        ALARM_TRANSITIONS[AlarmStatus.CANCELLED],
        AlarmStatus.CANCELLED,
        manager,
      );
      return { moved: ok, cancelledPending: ok ? await this.recipientRepository.cancelPending(id, manager) : 0 };
    });
    const alarm = await this.queryService.getEntityOrThrow(id);
    if (!moved) throw new AlarmInvalidStatusException(alarm.status, '취소');
    this.logger.log(`[발송 취소] alarmId=${id} cancelledPending=${cancelledPending}`);
    return AlarmResponse.from(alarm);
  }

  private validateRecipients(type: AlarmType, recipientIds: string[] | undefined): string[] {
    const ids = [...new Set(recipientIds ?? [])];
    if (type === AlarmType.BULK && ids.length > 0) {
      throw new AlarmRecipientsInvalidException('대량 알림은 수신자를 지정할 수 없습니다 (전체 사용자에게 발송).');
    }
    if (type === AlarmType.URGENT && (ids.length === 0 || ids.length > URGENT_MAX_RECIPIENTS)) {
      throw new AlarmRecipientsInvalidException(`긴급 알림은 수신자를 1~${URGENT_MAX_RECIPIENTS}명 지정해야 합니다.`);
    }
    return ids;
  }
}
