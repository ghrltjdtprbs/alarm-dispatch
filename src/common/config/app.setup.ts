import { INestApplication, ValidationPipe } from '@nestjs/common';

import { GlobalExceptionFilter } from '../exception/global-exception.filter';
import { ResponseInterceptor } from '../interceptor/response.interceptor';

/**
 * API 앱 공통 설정. main.ts 와 e2e 테스트(test/support)가 같은 함수를 써서 설정 차이를 없앤다.
 * - whitelist/forbidNonWhitelisted: DTO 에 없는 필드는 400
 * - transform: 쿼리 문자열 → DTO 타입 변환
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableShutdownHooks();
  return app;
}
