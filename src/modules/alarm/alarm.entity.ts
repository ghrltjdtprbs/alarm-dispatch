import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { BaseEntity } from '../../common/entity/base.entity';
import { AlarmStatus } from './alarm-status.enum';
import { AlarmType } from './alarm-type.enum';

/**
 * 알림. 상태 전이는 AlarmRepository.transition(조건부 UPDATE) 으로만 바꾼다 — 읽고-판단하고-쓰는 경합을 피하기 위해.
 * 목록 조회가 status 필터 + createdAt 역순이라 복합 인덱스를 둔다.
 */
@Entity('alarms')
@Index('idx_alarms_status_created_at', ['status', 'createdAt'])
export class Alarm extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 10 })
  type: AlarmType;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 20 })
  status: AlarmStatus;

  static create(type: AlarmType, title: string, body: string): Alarm {
    const alarm = new Alarm();
    alarm.type = type;
    alarm.title = title;
    alarm.body = body;
    alarm.status = AlarmStatus.CREATED;
    return alarm;
  }
}
