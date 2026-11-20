import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Configuration } from '../../common/config/configuration';

// 토큰 버킷 등 BullMQ 밖에서 쓰는 Redis 연결. 워커 종료 시 닫는다
@Injectable()
export class RedisConnection implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<Configuration, true>) {
    const redis = config.get('redis', { infer: true });
    this.client = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: 3 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
