# alarm-dispatch — 다수 수신자 알림 발송 시스템

NestJS 로 약 10만 명의 수신자에게 알림을 발송하는 백엔드입니다. REST API 로 알림을 생성·조회·발송 시작·취소하고,
발송 자체는 별도 워커 프로세스가 외부 발송 API(mock) 의 처리량 제한·일시 오류·타임아웃·영구 실패를 다루며 수행합니다.

- API 서버(`api`) 와 발송 워커(`worker`) 는 같은 이미지를 다른 진입점(`dist/main.js`, `dist/worker.js`) 으로 실행합니다.
- 상태의 단일 진실은 PostgreSQL 입니다. 모든 상태 전이는 조건부 원자 UPDATE 로만 일어나므로 API 와 워커가 동시에 같은 행을 건드려도 한 쪽만 성공합니다.
- Redis + BullMQ 는 잡 분배·우선순위·지연 재시도에, Redis 토큰 버킷은 워커 수와 무관한 전역 처리량 제한에 씁니다.

## 실행 방법

요구사항: Docker / Docker Compose. 로컬 개발·테스트는 Node 20 이상 (이미지는 Node 22).

```bash
cp .env.sample .env                 # 환경변수 (아래 표). 기본값으로 바로 실행됩니다
docker compose up --build           # api(3000) + worker + mock + postgres + redis
open http://localhost:3000/docs     # Swagger UI (OpenAPI 3.0 JSON: /docs-json, 파일: docs/openapi.json)
docker compose up --scale worker=3  # 워커 다중화
```

- 기동 순서는 healthcheck 로 보장됩니다 (postgres·redis·mock 이 healthy 가 된 뒤 api·worker 시작). 운영 모드(`NODE_ENV=production`) 에서는 기동 시 마이그레이션이 자동 적용되므로 빈 DB 에서도 바로 동작합니다.
- 기동 로그에 `[API 기동] port=3000 docs=/docs`, `[워커 준비] queue=dispatch concurrency=25` 가 보이면 준비된 것입니다.

테스트:

```bash
npm install
npm test                                                   # 단위 테스트 (인프라 불필요)
docker compose up -d postgres redis mock && npm run test:e2e   # e2e (.env.test 의 alarm_test DB, 실제 PostgreSQL/Redis)
npm run lint && npm run build
```

환경변수 (`.env.sample`):

| 키 | 설명 | 기본값 |
| --- | --- | --- |
| `API_PORT` | API 호스트 포트 | `3000` |
| `DB_*` | PostgreSQL 접속 (compose 는 `postgres` 서비스로 고정) | `alarm`/`alarm`/`alarm` |
| `DB_SYNCHRONIZE` | 로컬 개발용 스키마 자동 동기화. 운영에서는 무시되고 마이그레이션만 사용 | `false` |
| `REDIS_*` | Redis 접속 | `localhost:6379` |
| `MOCK_API_BASE_URL` | 외부 발송 mock 주소 (compose 내부는 `http://mock:4000`) | `http://localhost:4000` |
| `MOCK_API_PORT` | mock 호스트 포트 | `4000` |
| `SEND_RATE_LIMIT_PER_SEC` | 전역 처리량 제한 (mock 한도 50 에 10% 마진) | `45` |
| `SEND_REQUEST_TIMEOUT_MS` | 외부 API 요청 타임아웃 (mock 지연 3초 이상을 감안) | `5000` |
| `SEND_MAX_ATTEMPTS` | 5xx/네트워크 오류 재시도 상한 (429·타임아웃은 세지 않음) | `5` |
| `SEND_LEASE_SEC` | 수신자 점유(lease) 시간. 만료 후에도 처리 중이면 워커 사망으로 보고 복구 | `60` |
| `WORKER_CONCURRENCY` | 워커 프로세스당 동시 처리 잡 수 | `25` |
| `RECOVERY_SWEEP_INTERVAL_MS` | 고아 잡 복구 스윕 주기 | `60000` |

## 기술 스택과 선택 사유

과제 필수는 TypeScript + NestJS 뿐이며 나머지는 아래 이유로 골랐습니다.

| 영역 | 선택 | 사유 | 대안·트레이드오프 |
| --- | --- | --- | --- |
| DB | PostgreSQL 16 | `UPDATE ... WHERE status = ?` 조건부 원자 UPDATE, `(alarm_id, recipient_id)` 유니크, `INSERT ... ON CONFLICT DO NOTHING` 으로 정합성을 DB 가 보장. 10만 행 배치 insert 가 재실행 안전 | MySQL 도 가능하지만 `RETURNING`·부분 인덱스가 없어 조건부 UPDATE 의 결과 확인이 번거로움 |
| ORM | TypeORM 0.3 | Nest 공식 통합, 마이그레이션 CLI, QueryBuilder 로 조건부 UPDATE 작성이 쉬움 | Prisma 는 락·조건부 UPDATE 가 raw SQL 로 밀려 장점이 줄어듦 |
| 큐 | Redis 7 + BullMQ | 워커 간 잡 분배(잡 lock)·우선순위·지연 재시도·stalled 잡 복구가 내장. `queue.rateLimit()` 으로 429 시 큐 전역 일시정지 | 잡 10만 개가 Redis 에 수십 MB 올라감. 큐가 유실돼도 DB 상태로 복구 스윕이 재투입 |
| 처리량 제한 | Redis Lua 토큰 버킷 | 워커 수와 무관한 전역 제한, 긴급/대량이 같은 버킷을 공유. HTTP 호출 직전에만 토큰을 쓰므로 취소된 알림의 no-op 잡은 한도를 소모하지 않음 | BullMQ limiter 는 잡 단위·큐 단위라 no-op 잡도 제한에 걸리고 큐를 나누면 합산이 안 됨 |
| HTTP 클라이언트 | Node 내장 `fetch` + `AbortSignal.timeout` | 의존성 없이 타임아웃 처리 | axios 도 무방 |
| 검증·문서 | class-validator, `@nestjs/swagger` | DTO 한 곳에 검증 규칙과 문서를 같이 둠 | — |
| 테스트 | Jest + supertest | Nest 기본. e2e 는 실제 PostgreSQL/Redis(`*_test` DB 가 아니면 기동 거부) | — |

## API 사용법

기본 경로 `/api/v1`. 모든 응답은 `{ code, message, data, error? }` 로 감쌉니다 (`code` = HTTP 상태). 전체 스펙은 `docs/openapi.json` 또는 `/docs-json`.

| Method | Path | 설명 | 상태 코드 |
| --- | --- | --- | --- |
| POST | `/alarms` | 알림 생성 (BULK 전체 사용자 / URGENT 지정 수신자 1~100명) | 201, 400 |
| GET | `/alarms?page&size&status&type` | 목록 (생성일 역순, 페이지 0-based) | 200, 400 |
| GET | `/alarms/{id}` | 단건 + 수신자 상태별 집계(`progress`) | 200, 400, 404 |
| POST | `/alarms/{id}/send` | 발송 시작 (비동기, CREATED 에서만) | 202, 404, 409 |
| POST | `/alarms/{id}/cancel` | 발송 취소 (CREATED/PREPARING/SENDING 에서만) | 200, 404, 409 |
| GET | `/alarms/{id}/recipients?status&page&size` | 수신자별 발송 상태 (실패·미확정 확인용) | 200, 404 |

생성:

```bash
curl -s -X POST localhost:3000/api/v1/alarms -H 'content-type: application/json' \
  -d '{"title":"11월 정기 점검 안내","body":"11월 25일 02:00~04:00 서비스 점검이 있습니다."}'
```
```json
{ "code": 201, "message": null, "data": { "id": "9323718e-...", "type": "BULK", "title": "11월 정기 점검 안내", "body": "...", "status": "CREATED", "createdAt": "2026-11-20T11:26:25.000Z", "updatedAt": "2026-11-20T11:26:25.000Z" } }
```

긴급 알림 생성 (수신자는 mock 사용자 id):

```bash
curl -s -X POST localhost:3000/api/v1/alarms -H 'content-type: application/json' \
  -d '{"type":"URGENT","title":"인증번호","body":"123456","recipientIds":["u_000001","u_000002"]}'
```

발송 시작 → 진행 상황 조회:

```bash
curl -s -X POST localhost:3000/api/v1/alarms/9323718e-.../send      # 202, status: PREPARING
curl -s localhost:3000/api/v1/alarms/9323718e-...
```
```json
{ "code": 200, "message": null, "data": { "id": "9323718e-...", "status": "SENDING", "...": "...",
  "progress": { "total": 100000, "pending": 65333, "processing": 33, "sent": 34285, "failed": 348, "unknown": 1, "cancelled": 0 } } }
```

취소, 실패 수신자 확인:

```bash
curl -s -X POST localhost:3000/api/v1/alarms/9323718e-.../cancel     # 200, status: CANCELLED
curl -s 'localhost:3000/api/v1/alarms/9323718e-.../recipients?status=FAILED&size=20'
```

에러 응답:

```json
{ "code": 409, "message": "SENDING 상태의 알림은 발송 시작할 수 없습니다.", "data": null, "error": { "code": "ALARM_INVALID_STATUS" } }
{ "code": 400, "message": "요청 값이 올바르지 않습니다.", "data": null, "error": { "code": "VALIDATION_FAILED", "details": ["title must be longer than or equal to 1 characters"] } }
{ "code": 404, "message": "알림을 찾을 수 없습니다: ...", "data": null, "error": { "code": "ALARM_NOT_FOUND" } }
```

상태 코드 시맨틱: 검증 실패 400, 없는 리소스 404, 허용되지 않는 상태 전이 409, 비동기 수락 202. 에러 코드는 `src/common/exception/error-code.ts` 한 곳에 정의되고 전역 필터가 응답 형식으로 변환합니다.

## 데이터 모델과 상태 전이

`alarms` (id uuid, type, title, body, status) 와 `alarm_recipients` (id bigint, alarm_id, recipient_id, status, attempt_count, lease_until, message_id, last_error, sent_at). 수신자 테이블은 `(alarm_id, recipient_id)` 유니크, `(alarm_id, status)` 인덱스 (진행률 집계·완료 판정·취소 일괄 UPDATE 가 모두 이 조건). 스키마는 `src/migrations` 의 마이그레이션으로만 바뀝니다.

알림 상태:

| from → to | 누가 | 조건 (조건부 UPDATE WHERE) |
| --- | --- | --- |
| CREATED → PREPARING | API 발송 시작 | status = CREATED. 실패(affected 0) 면 409 |
| PREPARING → SENDING | 워커 prepare 잡 완료 | status = PREPARING |
| SENDING → COMPLETED | 워커, 마지막 수신자 종결 시 | status = SENDING AND 미종결 수신자 0건 |
| CREATED / PREPARING / SENDING → CANCELLED | API 취소 | status IN (…). 실패 면 409 |

수신자 상태:

```
PENDING ─(claim)─▶ PROCESSING ─▶ SENT | FAILED(영구: 400, 재시도 소진)
                       ├─(429 / 5xx 재시도)─▶ PENDING
                       └─(타임아웃: 발송됐을 수 있음)─▶ UNKNOWN ─(clientRef 조회)─▶ SENT | PENDING(재발송) | CANCELLED
PENDING ─(알림 취소)─▶ CANCELLED
```

완료 판정은 "성공률" 이 아니라 "모든 수신자가 종결(SENT/FAILED/CANCELLED)" 입니다. 일부 수신자는 항상 400 이므로 전원 성공은 불가능하고, 실패 수는 `progress.failed` 와 수신자 목록으로 확인합니다.

## 발송 처리 흐름

```
API   POST /alarms/:id/send ── CREATED→PREPARING (조건부 UPDATE) ── 큐에 prepare 잡 1개 투입
워커  prepare 잡  BULK:   mock GET /v1/users 를 커서(limit 1000)로 끝까지 읽으며 페이지마다
                          수신자 1000명 배치 insert(ON CONFLICT DO NOTHING) → send 잡 1000개 addBulk
                  URGENT: 생성 시 적재된 수신자로 send 잡 투입
                  끝나면 PREPARING→SENDING
워커  send 잡 (수신자 1명)
      [1] claim   조건부 UPDATE: PENDING→PROCESSING, 단 알림이 PREPARING/SENDING 일 때만. 실패면 아무것도 하지 않고 종료
      [2] call    토큰 버킷에서 토큰 획득 → POST /v1/messages (타임아웃 5초). 트랜잭션 밖
      [3] settle  조건부 UPDATE(WHERE status = PROCESSING) 로 결과 기록 → 미종결 0건이면 SENDING→COMPLETED
```

외부 API 응답별 처리 (`src/modules/dispatch/send.service.ts`):

| 응답 | 처리 |
| --- | --- |
| 202 | `SENT`, messageId 저장 |
| 400 (`RECIPIENT_BLOCKED`, `UNKNOWN_RECIPIENT`) | 재시도 없이 `FAILED`. 재시도는 낭비이고 한도만 소모 |
| 429 | 보내지지 않은 것으로 보고 `PENDING` 복귀, 시도 횟수 미차감. `queue.rateLimit(Retry-After)` 로 **모든 워커의 큐 소비를 일시정지** |
| 500 / 503 / 네트워크 오류 | `attempt_count + 1`, 지수 백오프(1s × 2ⁿ, 최대 30s) 후 재시도. 상한(5회) 도달 시 `FAILED` |
| 타임아웃 | **재전송하지 않고** `UNKNOWN`. 3초 뒤 `GET /v1/messages?clientRef=` 로 처리 여부를 확인해 있으면 `SENT`, 없으면 그제야 재발송 (알림이 취소됐으면 `CANCELLED`) |

처리량 제한: Redis Lua 토큰 버킷 (`src/modules/dispatch/rate-limiter.ts`). 보충·차감이 하나의 스크립트라 워커 여러 대가 동시에 와도 초과 발급이 없고, 버킷 용량을 rate 의 10% 로 작게 둬 어떤 1초 창에서도 통과 건수가 `rate + 용량 ≤ 50` 을 넘지 않습니다. 실측(워커 1대, 동시성 25) 약 40 rps, 429 0건.

`clientRef` 는 `${alarmId}:${recipientId}` 로 결정적입니다. mock 이 중복을 막지 않으므로 멱등성은 우리 상태 테이블이 책임지고, clientRef 는 타임아웃 뒤 "실제로 보내졌는지" 를 되묻는 키로 씁니다. BullMQ `jobId` 도 같은 규칙(`send-{alarmId}-{recipientId}`)이라 같은 수신자 잡이 두 번 투입되지 않습니다.

## 동시성·무결성

| 상황 | 방식 | 이유 |
| --- | --- | --- |
| 발송 시작 동시 N회 | `UPDATE alarms SET status='PREPARING' WHERE id=? AND status='CREATED'` → affected 1 인 요청만 큐 투입, 나머지 409 | 읽고-판단하고-쓰는 흐름이 없으니 락·버전 컬럼 없이 DB 가 경합을 끝냄 |
| 시작 vs 취소 경합 | 둘 다 조건부 UPDATE. 취소는 PREPARING/SENDING 에서도 허용 | 취소가 늦게 와도 워커가 claim 때 알림 상태를 다시 확인하므로 추가 발송 없음 |
| 워커 간 중복 claim | BullMQ 잡 lock(1차) + 수신자 행 조건부 UPDATE(2차) | stalled 로 잡이 두 번 전달돼도 행 상태가 PROCESSING/SENT 면 보내지 않음 |
| 취소 vs 진행 중 발송 | 취소 시 PENDING 일괄 CANCELLED. 호출 중(PROCESSING) 건은 결과대로 기록, 큐에 남은 잡은 claim 실패로 no-op (토큰 미소모) | 이미 외부로 나간 발송은 되돌릴 수 없음 |
| 타임아웃 중복 방지 | UNKNOWN 으로 두고 clientRef 조회 후에만 재발송 | 무조건 재전송하면 2% 가 중복, 무조건 실패 처리하면 누락 |
| 워커 사망 (kill -9) | BullMQ stalled 감지(15초)로 잡 재전달 → 행이 PROCESSING + lease 만료 → 결과 확인 경로. 2차로 주기 스윕이 lease 만료·오래된 UNKNOWN 을 재투입 | 실측: 발송 중 kill -9 → PROCESSING 고아 10건 → 60초 내 전부 복구, 중복 0 |
| 큐 유실 / 잡 영구 실패 | 스윕이 DB 기준으로 재투입. 큐에 아직 있는 잡은 우선순위만 올림 | 상태의 진실이 DB 라 Redis 가 비워져도 이어서 발송 가능 |
| 완료 판정 경합 | 마지막 두 수신자가 동시에 끝나도 `SENDING→COMPLETED` 조건부 UPDATE 는 한 번만 성공 | 카운터 컬럼 증감 대신 `EXISTS` 조회라 핫로우 경합이 없음 |
| 수신자 적재 중단 | `(alarm_id, recipient_id)` 유니크 + `ON CONFLICT DO NOTHING`, 잡은 jobId 로 dedupe | prepare 잡이 중간에 죽어 다시 돌아도 중복·누락 없음 |

트랜잭션 경계: 외부 HTTP 호출은 절대 트랜잭션 안에서 하지 않습니다 (커넥션 점유 + 타임아웃 시 롤백해도 외부는 이미 처리됨). claim(짧은 UPDATE) → call → settle(짧은 UPDATE) 세 단계로 나눕니다.

## 선택 구현 사항

**긴급 알림 우선 처리** — 같은 큐에서 BullMQ `priority` 를 씁니다 (긴급 prepare 1 / send 2, 대량 prepare 5 / send 10, 숫자가 작을수록 먼저). 대량 발송이 수신자 1명 = 잡 1개로 쪼개져 있어 10만 건 진행 중에도 긴급 잡이 바로 다음 순서에 끼어듭니다. 토큰 버킷은 하나이므로 긴급과 대량이 50 rps 를 함께 씁니다. 긴급 알림의 수신자는 생성 시 `recipientIds` 로 받아 바로 적재하고, 존재 여부는 mock 이 판정합니다 (`UNKNOWN_RECIPIENT` → FAILED).

**워커 다중화** (`docker compose up --scale worker=3`)
- 작업 분배: BullMQ 가 잡 단위로 워커에 lock 을 주어 분배합니다. 같은 잡이 두 워커에 가는 일은 lock 이 막고, 혹시 stalled 로 재전달돼도 수신자 행의 조건부 UPDATE 가 2차로 막습니다.
- 처리량 준수: 토큰 버킷이 Redis 에 하나뿐이라 워커가 몇 대든 합산 45 rps 입니다. 429 를 받으면 `queue.rateLimit()` 으로 모든 워커가 함께 멈춥니다.
- 종료 복구: SIGTERM 은 graceful shutdown(진행 중 잡 완료 후 종료). SIGKILL 은 stalled 감지 → 다른 워커가 잡을 받아 lease 만료 행을 결과 확인 경로로 처리합니다. 주기 스윕이 2차 안전망입니다.

## 테스트 전략

| 종류 | 위치 | 검증 내용 |
| --- | --- | --- |
| 단위 (33) | `src/**/*.spec.ts` | 상태 전이 표, 응답 래퍼·예외 필터, **발송 분기 전부**(2xx/400/429/5xx 상한/타임아웃/결과 확인 4가지) 를 fake 클라이언트·리포지토리로 인프라 없이 |
| e2e API (18) | `test/alarm.e2e-spec.ts` | 생성·검증 실패·목록·단건·수신자 목록, 발송 시작 **동시 10회 → 1건 202·9건 409·잡 1개**, 시작/취소 경합, 취소 후 수신자 상태 |
| e2e 리포지토리 (7) | `test/alarm-recipient.repository.e2e-spec.ts` | 실제 PostgreSQL 에서 claim 동시 8회 → 1건 성공, 취소된 알림 claim 거부, settle 은 PROCESSING 만, reclaim 은 lease 만료만, 복구 대상 선별, 적재 재실행 중복 없음 |
| 수동 시나리오 | compose 기동 | 10만 명 발송 처리량·429 여부, 발송 중 워커 kill -9 복구, 발송 중 취소, 긴급 알림 끼어들기 |

e2e 는 `.env.test` 의 `alarm_test` DB 와 별도 BullMQ 키 prefix 를 써서 로컬에서 돌고 있는 큐·데이터를 건드리지 않습니다. 테스트 DB 이름이 `_test` 로 끝나지 않으면 기동 자체를 거부합니다.

## 가정 및 해석

| 모호한 점 | 해석 |
| --- | --- |
| 생성 직후 상태, 완료 판정 | `CREATED` 로 생성. 모든 수신자가 종결되면 성공률과 무관하게 `COMPLETED` |
| 취소 범위 | CREATED/PREPARING/SENDING 에서 가능. 보낸 건은 SENT 유지, 미발송은 CANCELLED, 호출 중 건은 결과대로 |
| 수신자 적재 시점 | 대량은 발송 시작 시 워커가 mock 사용자 API 로 적재 (10만 건 적재가 수십 초라 API 요청 안에서 하지 않음). 긴급은 생성 시 |
| 타임아웃 건 | UNKNOWN → clientRef 조회로 확정. mock 이 `GET /v1/messages?clientRef=` 를 제공하는 것을 직접 확인 |
| 재시도 정책 | 5xx 최대 5회 지수 백오프, 429 는 시도에 안 세고 전역 일시정지, 처리량은 45 rps (10% 마진) |
| 발송 시작 응답 | 비동기 수락이므로 202 |
| 긴급 수신자 지정 | `recipientIds` (mock 사용자 id, 1~100). mock 에 단건 조회 API 가 없어 존재 여부는 발송 시 판정 |
| mock 사용자 API | 커서 페이징(limit ≤ 1000, `nextCursor` null 이 끝) — 직접 호출해 확인 |

## 고민했던 지점 / 되돌린 결정 / 더 하고 싶은 것

- **잡 단위**: 수신자 100명 배치 잡도 고려했지만, 느린 응답 하나가 배치를 막고 워커 사망 시 배치 전체를 재확인해야 해서 수신자 1명 = 잡 1개로 정했습니다. Redis 메모리(10만 잡 수십 MB)는 감수했고, 완료·실패 잡은 즉시 지워 이력을 Redis 에 쌓지 않습니다.
- **레이트리밋 위치**: 처음엔 BullMQ limiter 를 생각했지만 잡 단위 제한이라 취소된 알림의 no-op 잡까지 한도를 먹는 문제가 있어, HTTP 호출 직전에만 토큰을 쓰는 Lua 토큰 버킷으로 바꿨습니다.
- **되돌린 결정 1 — claim 판정**: TypeORM `repository.query()` 가 UPDATE 문에 `[rows, rowCount]` 를 돌려주는 것을 몰라 `rows.length === 1` 로 판정했고, 점유에 성공하고도 "거절" 로 처리돼 발송이 나가지 않았습니다. 복구 스윕이 lease 만료 건을 되살려 겉으로는 "1~2분 늦게 발송" 처럼 보여 원인 찾기가 어려웠습니다. 종료 사유 로그를 추가해 `claim_rejected` 를 확인하고 고쳤으며, 실 DB 리포지토리 e2e 로 고정했습니다. 교훈: 복구 경로가 1차 경로의 버그를 가릴 수 있으니 1차 경로의 결과도 관측해야 합니다.
- **되돌린 결정 2 — 재시도 잡의 우선순위**: BullMQ 는 지연 후 복귀한 잡을 같은 우선순위의 맨 뒤에 둡니다. 타임아웃 확인(UNKNOWN) 이 10만 건 뒤에서 기다리게 돼, 복귀 전에 `changePriority` 로 대량 잡은 5(긴급 뒤, 대량 앞)로 올리도록 바꿨습니다. 복구 스윕도 큐에 있는 잡은 재투입 대신 우선순위를 올립니다.
- **동시성 10 → 25**: mock 응답의 5% 가 3초, 2% 가 5초 타임아웃이라 평균 점유가 약 0.35초였고, 10 슬롯으로는 20~25 rps 에 그쳤습니다. 25 로 올려 약 40 rps 를 냅니다.
- **더 하고 싶은 것**: 알림별 처리량 지표(발송 속도·실패율) 노출, 워커 상태 헬스 엔드포인트(큐 깊이·stalled 수), 긴급 알림 전용 SLA 측정, 취소된 알림의 큐 잔여 잡 즉시 제거(현재는 no-op 로 빠르게 소진), 마이그레이션 기반 schema 변경 테스트.

## AI 활용 방식

Claude Code 를 설계·구현·검증 전 과정에 썼고, 다음 방식으로 결과를 통제했습니다.

- 컨벤션 문서와 훅으로 응답 형식·예외·Swagger 문서화·환경변수 동기화·커밋 규칙을 자동 검사했습니다.
- 과제 분석 → `docs/requirements.md` 에 요구사항 ID·가정·상태 모델·파이프라인을 먼저 확정한 뒤 구현했습니다.
- mock 서버는 문서 대신 이미지를 직접 띄워 응답 형식·에러 코드·페이징을 확인했고(`docs/mock-api.md`), 동시성·재시도·트랜잭션 코드는 직접 읽고 실제 기동·로그·실 DB 테스트로 검증했습니다.
- AI 가 틀린 부분을 잡아 고친 사례: 응답 본문 `code` 가 `@HttpCode(201)` 보다 먼저 계산돼 200 으로 찍히던 인터셉터, mock 포트 가정(8080 → 4000), TypeORM UPDATE 반환 형식 오판, BullMQ 지연 복귀 잡의 우선순위.
