import { Module } from '@nestjs/common';

import { HealthController } from './common/health/health.controller';
import { InfraModule } from './infra.module';
import { AlarmController } from './modules/alarm/alarm.controller';
import { AlarmModule } from './modules/alarm/alarm.module';

/** API 컨테이너 루트. 도메인 모듈은 import 하고 컨트롤러는 여기서만 등록한다 (워커에 HTTP 가 섞이지 않도록). */
@Module({
  imports: [InfraModule, AlarmModule],
  controllers: [HealthController, AlarmController],
})
export class ApiModule {}
