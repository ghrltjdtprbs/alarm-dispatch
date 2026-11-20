import { Injectable } from '@nestjs/common';

import { PagedResponse } from '../../common/dto/paged-response.dto';
import { Alarm } from './alarm.entity';
import { AlarmNotFoundException } from './alarm.exception';
import { AlarmRepository } from './alarm.repository';
import { AlarmRecipientRepository } from './alarm-recipient.repository';
import { AlarmResponse } from './dto/alarm.response';
import { AlarmDetailResponse } from './dto/alarm-detail.response';
import { AlarmListQuery } from './dto/alarm-list.query';
import { AlarmRecipientResponse } from './dto/alarm-recipient.response';
import { RecipientListQuery } from './dto/recipient-list.query';

/** 조회 전용. 상태를 바꾸지 않는다. CommandService 도 조회는 여기에 위임한다 (역방향 의존 금지). */
@Injectable()
export class AlarmQueryService {
  constructor(
    private readonly alarmRepository: AlarmRepository,
    private readonly recipientRepository: AlarmRecipientRepository,
  ) {}

  async list(query: AlarmListQuery): Promise<PagedResponse<AlarmResponse>> {
    const [alarms, total] = await this.alarmRepository.findPage({
      status: query.status,
      type: query.type,
      offset: query.offset,
      limit: query.size,
    });
    return PagedResponse.of(
      alarms.map((a) => AlarmResponse.from(a)),
      query.page,
      query.size,
      total,
    );
  }

  // 엔티티가 필요한 서비스 로직용. 없으면 404
  async getEntityOrThrow(id: string): Promise<Alarm> {
    const alarm = await this.alarmRepository.findById(id);
    if (!alarm) throw new AlarmNotFoundException(id);
    return alarm;
  }

  async getDetail(id: string): Promise<AlarmDetailResponse> {
    const alarm = await this.getEntityOrThrow(id);
    const counts = await this.recipientRepository.countByStatus(id);
    return AlarmDetailResponse.fromDetail(alarm, counts);
  }

  async listRecipients(alarmId: string, query: RecipientListQuery): Promise<PagedResponse<AlarmRecipientResponse>> {
    await this.getEntityOrThrow(alarmId);
    const [rows, total] = await this.recipientRepository.findPage(alarmId, query.status, query.offset, query.size);
    return PagedResponse.of(
      rows.map((r) => AlarmRecipientResponse.from(r)),
      query.page,
      query.size,
      total,
    );
  }
}
