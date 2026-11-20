import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'fs';
import { ApiModule } from '../src/api.module';
import { buildOpenApiDocument } from '../src/common/config/swagger.config';

// OpenAPI 3.0 문서를 docs/openapi.json 으로 내보낸다 (제출물). 실행: npm run openapi:export
// ApiModule 이 InfraModule 을 포함하므로 .env 의 PostgreSQL/Redis 에 연결 가능해야 한다
async function main(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { logger: ['error'] });
  const document = buildOpenApiDocument(app);
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/openapi.json', JSON.stringify(document, null, 2));
  await app.close();
  console.log('docs/openapi.json 생성 완료');
}

void main();
