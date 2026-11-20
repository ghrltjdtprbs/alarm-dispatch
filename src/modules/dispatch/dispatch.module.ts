import { Module } from '@nestjs/common';

import { AlarmModule } from '../alarm/alarm.module';
import { DispatchProcessor } from './dispatch.processor';
import { DispatchQueueModule } from './dispatch-queue.module';
import { MockSendClient } from './mock-send-client';
import { PrepareService } from './prepare.service';
import { RATE_LIMITER, RedisTokenBucket } from './rate-limiter';
import { RecoverySweeper } from './recovery.sweeper';
import { RedisConnection } from './redis.connection';
import { SendService } from './send.service';
import { SEND_CLIENT } from './send-client';

// 발송 워커 전용 모듈. 큐 소비(@Processor), 외부 API 호출, 레이트리밋, 복구 스윕. ApiModule 은 import 하지 않는다
@Module({
  imports: [AlarmModule, DispatchQueueModule],
  providers: [
    RedisConnection,
    { provide: RATE_LIMITER, useClass: RedisTokenBucket },
    { provide: SEND_CLIENT, useClass: MockSendClient },
    SendService,
    PrepareService,
    DispatchProcessor,
    RecoverySweeper,
  ],
})
export class DispatchModule {}
