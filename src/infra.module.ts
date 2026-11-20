import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Configuration, configuration, envValidationSchema } from './common/config/configuration';
import { typeOrmOptions } from './common/config/typeorm.config';

/**
 * API 와 Worker 가 공유하는 인프라 연결 (환경변수 검증, PostgreSQL, Redis/BullMQ).
 * 도메인 모듈은 여기 넣지 않는다 — ApiModule / WorkerModule 이 각자 필요한 것만 import 한다.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
      envFilePath: process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Configuration, true>) => typeOrmOptions(config),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Configuration, true>) => ({
        connection: config.get('redis', { infer: true }),
        // e2e 가 같은 Redis 를 쓰더라도 로컬에서 돌고 있는 큐를 비우지 않도록 키 prefix 를 분리한다
        prefix: config.get('app.env', { infer: true }) === 'test' ? 'bull-test' : 'bull',
      }),
    }),
  ],
})
export class InfraModule {}
