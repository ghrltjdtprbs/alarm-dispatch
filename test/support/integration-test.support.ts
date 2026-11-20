import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { ApiModule } from '../../src/api.module';
import { configureApp } from '../../src/common/config/app.setup';

/**
 * e2e 테스트용 앱 부트스트랩. main.ts 와 같은 configureApp 을 적용해 파이프/필터/인터셉터 차이를 없앤다.
 * PostgreSQL/Redis 가 떠 있어야 한다: docker compose up -d postgres redis mock (.env.test 참조)
 *
 * import * as request from 'supertest';   // tsconfig 에 esModuleInterop 이 없으므로 namespace import
 * const ctx = await createTestApp();
 * await request(ctx.server).get('/api/v1/alarms').expect(200);
 * await ctx.close();
 */
export interface TestContext {
  app: INestApplication;
  // supertest 에 바로 넘길 수 있게 타입을 맞춘 HTTP 서버
  server: App;
  dataSource: DataSource;
  truncateAll: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  const dataSource = app.get(DataSource);

  // 안전장치: truncateAll 이 개발 DB 를 비우지 않도록 테스트 DB(_test 접미사) 에서만 동작시킨다 (.env.test 가 안 읽힌 경우 탐지)
  const rawDatabase = (dataSource.options as { database?: unknown }).database;
  const database = typeof rawDatabase === 'string' ? rawDatabase : '';
  if (!database.endsWith('_test')) {
    await app.close();
    throw new Error(`e2e 는 *_test DB 에서만 실행한다. 현재 DB=${database}. NODE_ENV=test 와 .env.test 를 확인할 것`);
  }

  // 테스트 간 격리: 등록된 모든 엔티티 테이블을 비운다 (FK 무시, 시퀀스 초기화)
  const truncateAll = async (): Promise<void> => {
    const tables = dataSource.entityMetadatas.map((m) => `"${m.tableName}"`);
    if (tables.length === 0) return;
    await dataSource.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  };

  return { app, server: app.getHttpServer() as App, dataSource, truncateAll, close: () => app.close() };
}
