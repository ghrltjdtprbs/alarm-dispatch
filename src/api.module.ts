import { Module } from '@nestjs/common';
import { HealthController } from './common/health/health.controller';
import { InfraModule } from './infra.module';

// API 컨테이너 루트. 도메인 모듈(src/modules/*)의 HTTP 측 모듈을 여기에 import 한다
@Module({
  imports: [InfraModule],
  controllers: [HealthController],
})
export class ApiModule {}
