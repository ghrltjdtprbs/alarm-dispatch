import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

// 문서 버전 = package.json 버전. src/ 와 dist/ 어디서 실행돼도 프로젝트 루트는 세 단계 위
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SWAGGER_PATH = 'docs';

// OpenAPI 3.0 문서 생성. UI: /docs, JSON: /docs-json (scripts/export-openapi.ts 가 docs/openapi.json 으로 내보낸다)
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Alarm Dispatch API')
    .setDescription('다수 수신자 알림 생성·조회·발송·취소 API')
    .setVersion(packageVersion())
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_PATH, app, document, { jsonDocumentUrl: `${SWAGGER_PATH}-json` });
  return document;
}
