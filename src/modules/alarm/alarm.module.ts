import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DispatchQueueModule } from '../dispatch/dispatch-queue.module';
import { AlarmCommandService } from './alarm-command.service';
import { AlarmQueryService } from './alarm-query.service';
import { AlarmRecipientRepository } from './alarm-recipient.repository';
import { AlarmRecipient } from './alarm-recipient.entity';
import { AlarmRepository } from './alarm.repository';
import { Alarm } from './alarm.entity';

// 알림 도메인 코어. 컨트롤러는 ApiModule 이, 큐 소비는 WorkerModule 이 등록한다 (docs/conventions/module.md §3)
@Module({
  imports: [TypeOrmModule.forFeature([Alarm, AlarmRecipient]), DispatchQueueModule],
  providers: [AlarmRepository, AlarmRecipientRepository, AlarmQueryService, AlarmCommandService],
  exports: [AlarmRepository, AlarmRecipientRepository, AlarmQueryService, AlarmCommandService],
})
export class AlarmModule {}
