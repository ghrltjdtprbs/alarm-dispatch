import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { Configuration } from '../../common/config/configuration';

// 명령 실패 시 재시도 횟수. 그 이상이면 호출자에게 예외가 올라가 잡이 실패하고 복구 스윕 대상이 된다
const MAX_RETRIES_PER_REQUEST = 3;

/**
 * 토큰 버킷 등 BullMQ 밖에서 쓰는 Redis 연결.
 * onModuleDestroy 가 아니라 onApplicationShutdown 에서 닫는다 — Nest 는 모든 onModuleDestroy(워커가 진행 중 잡을 끝내는 곳) 를 먼저 부르므로,
 * 여기서 먼저 끊으면 호출 직전 잡들이 "Connection is closed" 로 실패한다.
 */
@Injectable()
export class RedisConnection implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(config: ConfigService<Configuration, true>) {
    const redis = config.get('redis', { infer: true });
    this.client = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
