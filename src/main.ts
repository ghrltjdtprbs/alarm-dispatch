import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { ApiModule } from './api.module';
import { configureApp } from './common/config/app.setup';
import { Configuration } from './common/config/configuration';
import { setupSwagger, SWAGGER_PATH } from './common/config/swagger.config';

// API 서버 진입점. 워커는 worker.ts
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  configureApp(app);
  setupSwagger(app);

  const config = app.get(ConfigService<Configuration, true>);
  const port = config.get('app.port', { infer: true });
  await app.listen(port);
  Logger.log(`[API 기동] port=${port} docs=/${SWAGGER_PATH}`, 'Bootstrap');
}

void bootstrap();
