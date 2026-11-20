import { Module } from '@nestjs/common';
import { InfraModule } from './infra.module';

// Worker 컨테이너 루트. 발송 처리(큐 소비, 외부 API 호출, 결과 반영) 모듈만 import 한다. HTTP 컨트롤러 금지
@Module({
  imports: [InfraModule],
})
export class WorkerModule {}
