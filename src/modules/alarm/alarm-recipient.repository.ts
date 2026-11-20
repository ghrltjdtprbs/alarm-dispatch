import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AlarmRecipient } from './alarm-recipient.entity';
import { RecipientStatus, UNSETTLED_RECIPIENT_STATUSES } from './recipient-status.enum';

export type RecipientStatusCounts = Record<RecipientStatus, number>;

// 수신자 상태 테이블 쿼리 전담. 10만 행 단위라 전부 집합 연산(배치 insert, 조건부 UPDATE, 집계) 으로 처리한다
@Injectable()
export class AlarmRecipientRepository {
  constructor(@InjectRepository(AlarmRecipient) private readonly repo: Repository<AlarmRecipient>) {}

  // 배치 적재. (alarm_id, recipient_id) 유니크 충돌은 무시 → 적재를 중단 후 재실행해도 중복이 생기지 않는다
  // manager 를 넘기면 호출자의 트랜잭션 안에서 실행된다 (알림 생성과 긴급 수신자 적재를 원자적으로)
  async insertPendingIgnoreDuplicates(alarmId: string, recipientIds: string[], manager?: EntityManager): Promise<void> {
    if (recipientIds.length === 0) return;
    await (manager ?? this.repo.manager)
      .createQueryBuilder()
      .insert()
      .into(AlarmRecipient)
      .values(recipientIds.map((recipientId) => ({ alarmId, recipientId, status: RecipientStatus.PENDING })))
      .orIgnore()
      .execute();
  }

  async countByStatus(alarmId: string): Promise<RecipientStatusCounts> {
    const rows = await this.repo
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('r.alarm_id = :alarmId', { alarmId })
      .groupBy('r.status')
      .getRawMany<{ status: RecipientStatus; count: string }>();
    const counts = Object.fromEntries(Object.values(RecipientStatus).map((s) => [s, 0])) as RecipientStatusCounts;
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  async hasUnsettled(alarmId: string): Promise<boolean> {
    return this.repo.exists({
      where: UNSETTLED_RECIPIENT_STATUSES.map((status) => ({ alarmId, status })),
    });
  }

  findPage(
    alarmId: string,
    status: RecipientStatus | undefined,
    offset: number,
    limit: number,
  ): Promise<[AlarmRecipient[], number]> {
    const qb = this.repo.createQueryBuilder('r').where('r.alarm_id = :alarmId', { alarmId }).orderBy('r.id', 'ASC');
    if (status) qb.andWhere('r.status = :status', { status });
    return qb.skip(offset).take(limit).getManyAndCount();
  }

  // 알림 취소 시 아직 손대지 않은 수신자만 일괄 취소. PROCESSING(호출 중) 은 결과대로 남긴다
  async cancelPending(alarmId: string): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(AlarmRecipient)
      .set({ status: RecipientStatus.CANCELLED })
      .where('alarm_id = :alarmId AND status = :pending', { alarmId, pending: RecipientStatus.PENDING })
      .execute();
    return result.affected ?? 0;
  }
}
