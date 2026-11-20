import { Injectable } from '@nestjs/common';
import { PagedResponse } from '../../common/dto/paged-response.dto';
import { AlarmRecipientRepository } from './alarm-recipient.repository';
import { AlarmRepository } from './alarm.repository';
import { AlarmNotFoundException } from './alarm.exception';
import { AlarmListQuery } from './dto/alarm-list.query';
import { AlarmRecipientResponse } from './dto/alarm-recipient.response';
import { AlarmDetailResponse, AlarmResponse } from './dto/alarm.response';
import { RecipientListQuery } from './dto/recipient-list.query';

// 조회 전용. 상태를 바꾸지 않는다
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

  async getDetail(id: string): Promise<AlarmDetailResponse> {
    const alarm = await this.alarmRepository.findById(id);
    if (!alarm) throw new AlarmNotFoundException(id);
    const counts = await this.recipientRepository.countByStatus(id);
    return AlarmDetailResponse.fromDetail(alarm, counts);
  }

  async listRecipients(alarmId: string, query: RecipientListQuery): Promise<PagedResponse<AlarmRecipientResponse>> {
    const alarm = await this.alarmRepository.findById(alarmId);
    if (!alarm) throw new AlarmNotFoundException(alarmId);
    const [rows, total] = await this.recipientRepository.findPage(alarmId, query.status, query.offset, query.size);
    return PagedResponse.of(
      rows.map((r) => AlarmRecipientResponse.from(r)),
      query.page,
      query.size,
      total,
    );
  }
}
