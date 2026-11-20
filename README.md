# alarm-dispatch (하네스 템플릿 상태)

어스얼라이언스 백엔드 과제용 NestJS 프로젝트. 공통 모듈과 실행 환경이 구성된 상태이며, 구현이 끝나면 이 README 를 과제 제출 기준(실행 방법, API 사용법, 구현 코멘트)으로 다시 쓴다.

## 빠른 시작

```bash
cp .env.sample .env
npm install
npm run lint && npm run build && npm test
docker compose up --build            # api(3000) + worker + mock + postgres + redis
open http://localhost:3000/docs      # Swagger UI
```

## 구성

| 영역 | 위치 | 내용 |
| --- | --- | --- |
| 진입점 | `src/main.ts`, `src/worker.ts` | API 서버 / 발송 워커 (같은 이미지, command 만 다름) |
| 루트 모듈 | `src/api.module.ts`, `src/worker.module.ts`, `src/infra.module.ts` | HTTP 측 / 워커 측 / 공유 인프라(Config·TypeORM·BullMQ) |
| 공통 응답 | `src/common/dto` | `ResponseDTO<T>` (`{code, message, data, error?}`), `PagedResponse<T>`, `PaginationQuery` |
| 예외 | `src/common/exception` | `ErrorCode`, `ApplicationException`, predefined 400/401/403/404/409/500, `GlobalExceptionFilter` |
| 인터셉터 | `src/common/interceptor` | 컨트롤러 반환값을 `ResponseDTO` 로 래핑 |
| 엔티티 | `src/common/entity` | `BaseEntity` (createdAt/updatedAt) |
| 설정 | `src/common/config` | Joi 환경변수 검증(`configuration.ts`), TypeORM, Swagger, `configureApp` |
| Swagger 헬퍼 | `src/common/swagger` | `ApiOkResponseDTO`, `ApiPagedResponseDTO`, `ApiEmptyResponseDTO`, `ApiErrorResponseDTO` |
| 테스트 지원 | `test/support` | `createTestApp` (e2e), `runConcurrently` (경합 재현) |
| 인프라 | `docker-compose.yml`, `Dockerfile`, `docker/postgres` | `api`, `worker`, `mock`, `postgres`, `redis` |
