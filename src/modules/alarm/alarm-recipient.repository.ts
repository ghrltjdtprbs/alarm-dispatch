import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AlarmRecipient } from './alarm-recipient.entity';
import { AlarmStatus } from './alarm-status.enum';
import { AlarmType } from './alarm-type.enum';
import { RecipientStatus, UNSETTLED_RECIPIENT_STATUSES } from './recipient-status.enum';

export type RecipientStatusCounts = Record<RecipientStatus, number>;

// settle 시 바꾸는 필드. status 외는 선택
export interface RecipientSettlePatch {
  status: RecipientStatus;
  attemptCount?: number;
  messageId?: string | null;
  lastError?: string | null;
  sentAt?: Date | null;
}

export interface RecoverableRecipient {
  alarmId: string;
  recipientId: string;
  type: AlarmType;
}

// 발송 가능한 알림 상태. claim 은 이 상태의 알림에 속한 수신자만 잡는다 (취소되면 바로 멈춘다)
const SENDABLE_ALARM_STATUSES = [AlarmStatus.PREPARING, AlarmStatus.SENDING];

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

  findOne(alarmId: string, recipientId: string): Promise<AlarmRecipient | null> {
    return this.repo.findOne({ where: { alarmId, recipientId } });
  }

  // 알림의 수신자 id 를 id 순으로 페이지 조회 (긴급 알림 send 잡 투입, 복구용)
  async findRecipientIds(
    alarmId: string,
    afterId: string | null,
    limit: number,
  ): Promise<{ id: string; recipientId: string }[]> {
    const qb = this.repo
      .createQueryBuilder('r')
      .select(['r.id AS id', 'r.recipient_id AS "recipientId"'])
      .where('r.alarm_id = :alarmId', { alarmId })
      .orderBy('r.id', 'ASC')
      .limit(limit);
    if (afterId) qb.andWhere('r.id > :afterId', { afterId });
    return qb.getRawMany<{ id: string; recipientId: string }>();
  }

  /**
   * [claim] PENDING → PROCESSING. 알림이 발송 가능 상태일 때만 성공한다 (취소된 알림은 여기서 걸러진다).
   * 같은 수신자 잡이 두 워커에 동시에 들어와도 UPDATE 는 한 쪽만 성공한다.
   */
  async claim(alarmId: string, recipientId: string, leaseUntil: Date): Promise<boolean> {
    // TypeORM 의 query() 는 UPDATE 문에 대해 [rows, rowCount] 를 돌려준다 (SELECT 처럼 rows 가 아님). rowCount 로 판정한다
    const [, affected] = await this.repo.query<[unknown[], number]>(
      `UPDATE alarm_recipients r
         SET status = $1, lease_until = $2, updated_at = now()
        FROM alarms a
       WHERE a.id = r.alarm_id AND r.alarm_id = $3 AND r.recipient_id = $4
         AND r.status = $5 AND a.status = ANY($6)
       RETURNING r.id`,
      [RecipientStatus.PROCESSING, leaseUntil, alarmId, recipientId, RecipientStatus.PENDING, SENDABLE_ALARM_STATUSES],
    );
    return affected === 1;
  }

  /**
   * [reclaim] 결과 확인이 필요한 건을 다시 점유한다: UNKNOWN(타임아웃) 또는 lease 가 만료된 PROCESSING(워커 사망).
   * 알림이 취소됐어도 실행한다 — 이미 발송됐는지 확인해 SENT 로 기록해야 하므로.
   */
  async reclaimForReconcile(alarmId: string, recipientId: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(AlarmRecipient)
      .set({ status: RecipientStatus.PROCESSING, leaseUntil })
      .where('alarm_id = :alarmId AND recipient_id = :recipientId', { alarmId, recipientId })
      .andWhere('(status = :unknown OR (status = :processing AND lease_until < now()))', {
        unknown: RecipientStatus.UNKNOWN,
        processing: RecipientStatus.PROCESSING,
      })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  // [settle] PROCESSING 인 행만 결과를 기록한다. 그 사이 다른 경로가 바꿨으면 affected 0
  async settle(alarmId: string, recipientId: string, patch: RecipientSettlePatch): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(AlarmRecipient)
      .set({ ...patch, leaseUntil: null })
      .where('alarm_id = :alarmId AND recipient_id = :recipientId AND status = :processing', {
        alarmId,
        recipientId,
        processing: RecipientStatus.PROCESSING,
      })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  /**
   * 복구 대상: lease 만료 PROCESSING, 오래된 UNKNOWN, 오래된 PENDING(잡 유실). 알림이 종료되지 않은 것만.
   * 재투입은 jobId 가 결정적이라 이미 큐에 있으면 무시된다
   */
  findRecoverable(staleSec: number, limit: number): Promise<RecoverableRecipient[]> {
    return this.repo.query<RecoverableRecipient[]>(
      `SELECT r.alarm_id AS "alarmId", r.recipient_id AS "recipientId", a.type AS type
         FROM alarm_recipients r JOIN alarms a ON a.id = r.alarm_id
        WHERE a.status = ANY($1)
          AND ((r.status = $2 AND r.lease_until < now())
            OR (r.status IN ($3, $4) AND r.updated_at < now() - ($5 || ' seconds')::interval))
        ORDER BY r.updated_at ASC
        LIMIT $6`,
      [
        [...SENDABLE_ALARM_STATUSES, AlarmStatus.CANCELLED],
        RecipientStatus.PROCESSING,
        RecipientStatus.UNKNOWN,
        RecipientStatus.PENDING,
        String(staleSec),
        limit,
      ],
    );
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
