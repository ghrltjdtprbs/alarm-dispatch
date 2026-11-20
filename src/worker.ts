import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// 발송 워커 진입점. HTTP 없이 애플리케이션 컨텍스트만 띄운다 (createApplicationContext 가 init 까지 수행).
// enableShutdownHooks: SIGTERM 시 onModuleDestroy/beforeApplicationShutdown 이 호출되어 처리 중인 작업을 정리할 수 있다
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(`[Worker 기동] pid=${process.pid}`, 'Bootstrap');
}

void bootstrap();
