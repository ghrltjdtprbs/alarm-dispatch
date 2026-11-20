import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlarmStatus } from './alarm-status.enum';
import { AlarmType } from './alarm-type.enum';
import { Alarm } from './alarm.entity';

export interface AlarmPageFilter {
  status?: AlarmStatus;
  type?: AlarmType;
  offset: number;
  limit: number;
}

// 알림 테이블 쿼리 전담. 상태 변경은 전부 조건부 UPDATE 라 "읽고 판단하고 쓰는" 경합이 없다
@Injectable()
export class AlarmRepository {
  constructor(@InjectRepository(Alarm) private readonly repo: Repository<Alarm>) {}

  save(alarm: Alarm): Promise<Alarm> {
    return this.repo.save(alarm);
  }

  findById(id: string): Promise<Alarm | null> {
    return this.repo.findOne({ where: { id } });
  }

  findPage(filter: AlarmPageFilter): Promise<[Alarm[], number]> {
    const qb = this.repo.createQueryBuilder('a').orderBy('a.createdAt', 'DESC').skip(filter.offset).take(filter.limit);
    if (filter.status) qb.andWhere('a.status = :status', { status: filter.status });
    if (filter.type) qb.andWhere('a.type = :type', { type: filter.type });
    return qb.getManyAndCount();
  }

  /**
   * 조건부 상태 전이. from 에 있는 상태일 때만 to 로 바꾸고 성공 여부를 돌려준다.
   * 같은 알림에 동시 요청이 와도 DB 가 한 건만 성공시키므로 별도 락이 필요 없다.
   */
  async transition(id: string, from: readonly AlarmStatus[], to: AlarmStatus): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Alarm)
      .set({ status: to })
      .where('id = :id AND status IN (:...from)', { id, from })
      .execute();
    return (result.affected ?? 0) === 1;
  }
}
