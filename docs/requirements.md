# 요구사항 정리 (알림 발송 시스템)

> 과제 원문은 비공개 자료라 요약만 적는다. 결정 사항은 README 에 "가정" 으로 옮긴다.

## 문제 요약

NestJS 로 약 10만 명에게 알림을 보내는 시스템. API(생성·목록·단건·발송 시작·취소) 와 발송 워커를 별도 컨테이너로 두고,
제공된 mock 발송 서버(50 rps 제한, 5% 5xx, 2% 타임아웃(발송은 됨), 일부 400 영구 실패, 중복 방지 없음)와 연동한다.
`docker compose up` 한 번에 전부 떠야 하고, OpenAPI 3.0 문서와 테스트가 있어야 한다. 선택: 긴급 알림 우선 처리, 워커 다중화.

## 기능 요구사항

| ID | 내용 | 원문 근거 |
| --- | --- | --- |
| F-1 | 알림 생성 (uuid id, title, body, status 최소 보유) | 데이터 모델·API 1 |
| F-2 | 알림 목록 조회 | API 2 |
| F-3 | 알림 단건 조회 (발송 진행 상황 포함) | API 3 |
| F-4 | 알림 발송 시작 — 수신자는 mock 사용자 API 의 전체 사용자 | API 4, 발송 처리 |
| F-5 | 알림 발송 취소 — 진행 중이어도 남은 수신자에게 보내지 않음 | API 5 |
| F-6 | 발송은 API 프로세스가 아닌 별도 워커 프로세스에서 처리 | 발송 처리, 실행 구성 |
| F-7 | compose 서비스명 `api`, `worker`, `docker compose up` 한 번으로 실행 | 실행 구성, 제출 |

## 비기능 요구사항

| ID | 내용 | 대응 방식 |
| --- | --- | --- |
| N-1 | 동시 요청(시작/취소/조회)과 워커 처리가 같은 데이터를 건드려도 상태 불일치·중복·누락 없음 | 조건부 원자 UPDATE 로 상태 전이, 수신자 (alarm_id, recipient_id) 유니크, claim/settle 조건부 UPDATE |
| N-2 | 50 rps 초과 금지, 429 지속 금지 | Redis 토큰 버킷(Lua, 전역) + 429 시 `Retry-After` 를 버킷 `pause_until` 에 기록해 모든 워커의 호출 일시정지 |
| N-3 | 5xx 일시 오류 복구 | 지수 백오프 재시도, 상한 후 FAILED |
| N-4 | 타임아웃(발송됐을 수 있음) 중복 발송 금지 | UNKNOWN 으로 두고 `GET /v1/messages?clientRef=` 조회로 확정 후 미발송일 때만 재시도 |
| N-5 | 400 영구 실패 | 재시도 없이 FAILED(영구) |
| N-6 | HTTP 시맨틱 상태 코드 + 일관된 에러 응답 | `ResponseDTO` + `GlobalExceptionFilter`, 404/409/400 구분 |
| N-7 | 핵심 로직 테스트 | 단위(fake 클라이언트로 응답 시나리오), e2e(API 흐름·경합), 통합(토큰 버킷) |
| N-8 | OpenAPI 3.0 문서 | `@nestjs/swagger`, `/docs`, `docs/openapi.json` |
| N-9 | 운영 배포 가정 | 헬스체크, graceful shutdown, 마이그레이션 자동 적용, Joi 설정 검증, 구조화 로그 |

## 선택 구현 사항

| ID | 내용 | 구현 여부 / 방식 |
| --- | --- | --- |
| O-1 | 긴급 알림: 생성 시 종류·수신자(≤100) 지정, 대량보다 먼저 처리, 50 rps 공유 | 구현. 같은 큐에서 BullMQ `priority` 로 긴급(1) > 대량(10). 토큰 버킷은 하나라 처리량 공유 |
| O-2 | 워커 다중화(`--scale worker=3`): 429 지속 금지, 중복·누락 금지, 워커 종료 시 이어서 발송 | 구현. BullMQ 가 잡을 워커에 분배(잡 lock), 수신자 상태 조건부 UPDATE 로 이중 방어, stalled 잡 재투입 + 수신자 lease 만료 건 복구 스윕 |

## 질문 / 가정 (과제 측 질문 불가 → 결정으로 확정)

| ID | 모호한 점 | 결정(가정) | 근거 |
| --- | --- | --- | --- |
| Q-1 | 생성 직후 상태, 완료 판정 | `CREATED` 로 생성. 모든 수신자가 종결(SENT/FAILED/CANCELLED)되면 성공률과 무관하게 `COMPLETED`. 실패 수는 진행 상황으로 노출 | 10만 명 중 1% 는 항상 400 이라 "전원 성공" 은 불가능 |
| Q-2 | 취소 가능 상태, 취소 시 이미 보낸 건 | `CREATED/PREPARING/SENDING` 에서 취소 가능. 보낸 건은 `SENT` 유지, 미발송 `PENDING` 은 `CANCELLED`, 호출 중(PROCESSING) 건은 결과대로 기록 | 외부로 나간 발송은 되돌릴 수 없음 |
| Q-3 | 수신자 적재 시점·주체 | 대량: 발송 시작 시 **워커**가 mock 사용자 API 를 커서로 읽어 적재(`PREPARING`). 긴급: 생성 시 지정 수신자를 바로 적재 | 10만 건 적재는 수십 초 → API 요청 안에서 하면 타임아웃·중복 위험 |
| Q-4 | 타임아웃 건 최종 상태 | `UNKNOWN` → 백오프 후 clientRef 조회 → 있으면 `SENT`, 없으면 재발송. 취소된 알림이면 재발송 대신 `CANCELLED` | mock 이 clientRef 조회 API 를 제공 (`docs/mock-api.md`) |
| Q-5 | 재시도·백오프·429·안전 마진 | 5xx/연결 거부 최대 5회, 지수 백오프 1s×2ⁿ(상한 30s). 소켓 끊김은 타임아웃과 같이 조회로 확정. 429 는 시도 횟수에 안 세고 `Retry-After` 동안 토큰 버킷 전역 일시정지. 토큰 버킷 상한 45 rps(10% 마진) | 경계 초 단위 집계 차이로 50 꽉 채우면 간헐 429 |
| Q-6 | 큐/조정 계층 | Redis + BullMQ (잡 = 수신자 1명). DB(PostgreSQL) 가 상태의 단일 진실 | 분배·우선순위·stalled 복구가 내장. 상태는 DB 에 있어 큐가 날아가도 복구 스윕으로 재투입 가능 |
| Q-7 | 긴급 수신자 지정 방식 | 생성 요청의 `recipientIds: string[]`(1~100, mock 사용자 `id`). 존재 여부는 발송 시 mock 이 판정(`UNKNOWN_RECIPIENT` → FAILED) | mock 에 사용자 단건 조회 API 가 없음 |
| Q-8 | 발송 시작 응답 코드 | `202 Accepted` + 알림 현재 상태 | 비동기 처리 수락의 표준 시맨틱 |
| Q-9 | 마감 해석 | 수령일(11-18) 포함 3일 → 11-20 23:59:59 | 보수적 해석 |

## 기술 선택과 사유

| 영역 | 선택 | 사유 | 대안·한계 |
| --- | --- | --- | --- |
| DB | PostgreSQL 16 | 조건부 UPDATE·유니크 제약·부분 인덱스로 정합성을 DB 가 보장. 수신자 10만 행 배치 insert(`ON CONFLICT DO NOTHING`) 재실행 가능 | MySQL 도 가능하나 `RETURNING`·부분 인덱스 부재 |
| ORM | TypeORM 0.3 | Nest 공식 통합, 마이그레이션 CLI, QueryBuilder 로 조건부 UPDATE 작성 용이 | Prisma 는 락·조건부 UPDATE 가 raw SQL 로 밀림 |
| 큐 | Redis 7 + BullMQ | 워커 간 잡 분배·우선순위·지연 재시도·stalled 복구 내장, `rateLimit()` 로 429 전역 일시정지 | 잡 10만 개 Redis 메모리 수십 MB. 큐 유실 대비 DB 복구 스윕 |
| 레이트리밋 | Redis Lua 토큰 버킷(전역) | 워커 수와 무관, 긴급/대량이 같은 버킷. HTTP 호출 직전에만 토큰 소비 → 취소된 잡(no-op)은 토큰을 안 씀 | BullMQ limiter 는 잡 단위라 no-op 잡도 제한에 걸림 |
| HTTP 클라이언트 | Node 22 내장 `fetch` + `AbortSignal.timeout` | 의존성 없음, 타임아웃 간단 | axios 도 가능 |
| 테스트 | Jest + supertest | Nest 기본, e2e 는 실제 Postgres/Redis(`*_test` DB) | — |

## 도메인 설계

### alarms

| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | uuid PK | 과제 명세 |
| type | varchar enum `BULK` / `URGENT` | 긴급 여부 |
| title | varchar(200) | |
| body | text | |
| status | varchar enum | 아래 전이 표 |
| created_at / updated_at | timestamptz | BaseEntity |

### 알림 상태 전이

| from → to | 누가 | 조건 (조건부 UPDATE WHERE) |
| --- | --- | --- |
| CREATED → PREPARING | API 발송 시작 | status = CREATED (affected 0 → 409) |
| PREPARING → SENDING | 워커 prepare 잡 끝 | status = PREPARING |
| SENDING → COMPLETED | 워커 settle(마지막 수신자) | status = SENDING AND 미종결 수신자 0건 |
| CREATED/PREPARING/SENDING → CANCELLED | API 취소 | status IN (…) (affected 0 → 409) |

### alarm_recipients

| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | bigint identity PK | 10만 행 × 알림 수 → uuid 보다 인덱스 작음 |
| alarm_id | uuid FK (CASCADE) | |
| recipient_id | varchar(32) | mock 사용자 id (`u_000001`) |
| status | varchar enum | PENDING / PROCESSING / SENT / FAILED / UNKNOWN / CANCELLED |
| attempt_count | int | 5xx 재시도 횟수 |
| lease_until | timestamptz null | PROCESSING 점유 만료. 만료 후에도 PROCESSING 이면 워커 사망 → 복구 대상 |
| message_id | varchar null | mock 응답 messageId |
| last_error | varchar null | 마지막 오류 코드 (`RECIPIENT_BLOCKED` 등) |
| sent_at | timestamptz null | |
| UNIQUE (alarm_id, recipient_id) | | 중복 적재 방지 (재실행 안전) |
| INDEX (alarm_id, status) | | 진행률 집계·완료 판정·취소 일괄 UPDATE |

`clientRef` = `${alarm_id}:${recipient_id}` (결정적). BullMQ `jobId` 도 같은 값 → 같은 수신자 잡 중복 투입 불가.

### 수신자 상태 전이

| from → to | 시점 |
| --- | --- |
| PENDING → PROCESSING | claim (lease_until = now + lease) |
| PROCESSING → SENT / FAILED | settle |
| PROCESSING → PENDING | 429 (시도 안 셈) / 5xx (attempt+1, 백오프 재시도) |
| PROCESSING → UNKNOWN | 타임아웃 |
| UNKNOWN → SENT / PENDING / CANCELLED | 조회 결과 있음 / 없음(재발송) / 없음 + 알림 취소됨 |
| PENDING → CANCELLED | 알림 취소 시 일괄 |

## 발송 파이프라인

```
API  POST /alarms/:id/send ─ CREATED→PREPARING (조건부) ─ 큐에 prepare 잡 1개
Worker prepare 잡: BULK 면 mock /v1/users 커서(limit 1000) 순회 → 1000건 insert ON CONFLICT DO NOTHING → 1000개 send 잡 addBulk
                   URGENT 면 생성 시 적재된 수신자로 send 잡 addBulk
                   끝나면 PREPARING→SENDING, 완료 판정 1회
Worker send 잡(수신자 1명):
  [1] claim   조건부 UPDATE: PENDING→PROCESSING WHERE 알림 status IN (PREPARING, SENDING). affected 0 → 상태 보고 분기(UNKNOWN 이면 reconcile, 그 외 no-op)
  [2] call    토큰 버킷 대기 → POST /v1/messages (timeout 5s)
  [3] settle  조건부 UPDATE WHERE status = PROCESSING AND lease_until = 내 펜스 → SENT/FAILED/PENDING/UNKNOWN. SENT/FAILED 면 미종결 0건 확인 → SENDING→COMPLETED
```

| 장애·경합 시나리오 | 대응 |
| --- | --- |
| 발송 시작 동시 2회 | 조건부 UPDATE affected=1 인 요청만 큐 투입. 나머지 409 |
| prepare 중 워커 사망 | stalled → 다른 워커가 재실행. insert 는 ON CONFLICT, 잡은 jobId 로 dedupe → 중복 없음 |
| send 중 워커 사망(docker kill) | BullMQ stalled 감지로 잡 재투입 → 행이 PROCESSING + lease 만료 → reconcile(clientRef 조회) → SENT 또는 재발송 |
| 큐 자체 유실/잡 영구 실패 | 워커의 주기 스윕: lease 만료 PROCESSING·오래된 UNKNOWN·PENDING(잡 없음) 을 다시 addBulk(jobId dedupe) |
| 취소 vs 진행 중 발송 | 취소 시 PENDING 일괄 CANCELLED + 알림 CANCELLED. claim 이 알림 상태를 조건으로 하므로 이후 잡은 no-op(토큰 안 씀). 호출 중 건은 결과대로 |
| 429 | 행 PENDING 복귀, 토큰 버킷 `pause_until` 로 전역 일시정지, 잡 지연 재투입(시도 미차감) |
| 타임아웃 | UNKNOWN + 지연 재시도 → 조회로 확정 |
| 완료 판정 경합(마지막 2건 동시 settle) | 둘 다 미종결 0 을 보더라도 SENDING→COMPLETED 조건부 UPDATE 는 1건만 성공 |

## API 설계 (`/api/v1`)

| Method | Path | 요청 | 응답 | 에러 |
| --- | --- | --- | --- | --- |
| POST | `/alarms` | `{type?: BULK\|URGENT(기본 BULK), title, body, recipientIds?: string[]}` (URGENT 는 1~100개 필수, BULK 는 금지) | 201 `AlarmResponse` | 400 VALIDATION_FAILED / ALARM_RECIPIENTS_INVALID |
| GET | `/alarms?page&size&status&type` | `PaginationQuery` + 필터 | 200 `PagedResponse<AlarmResponse>` | 400 |
| GET | `/alarms/:id` | uuid | 200 `AlarmDetailResponse` (알림 + `progress {total, pending, processing, sent, failed, unknown, cancelled}`) | 400 형식, 404 ALARM_NOT_FOUND |
| POST | `/alarms/:id/send` | — | 202 `AlarmResponse` (status PREPARING) | 404, 409 ALARM_INVALID_STATUS |
| POST | `/alarms/:id/cancel` | — | 200 `AlarmResponse` (status CANCELLED) | 404, 409 ALARM_INVALID_STATUS |
| GET | `/alarms/:id/recipients?status&page&size` | 필터 | 200 `PagedResponse<RecipientResponse>` | 404 |

`AlarmResponse`: id, type, title, body, status, createdAt, updatedAt. `AlarmDetailResponse` = AlarmResponse + progress.

## 구현 계획 (각 단계 끝에 /commit)

1. 알림 도메인: enum·엔티티·리포지토리·Query/Command 서비스·컨트롤러·DTO, 마이그레이션 1개. 테스트: 전이 단위, e2e 생성/목록/단건/404/400, 발송 시작 동시 N → 1건 202 나머지 409 (`runConcurrently`), 취소 409.
2. 발송 인프라: `SendClient` 인터페이스 + mock HTTP 구현(fetch, timeout), Redis 토큰 버킷(Lua), 큐 모듈(등록 + producer). 테스트: 버킷 통합(1초에 N 초과 안 함).
3. 워커: prepare 프로세서(사용자 적재·잡 투입), send 프로세서(claim→call→settle, 429/5xx/400/timeout 분기, reconcile), 완료 판정, 복구 스윕. 테스트: fake 클라이언트로 분기별 단위 테스트, e2e 취소 후 추가 발송 0건.
4. 선택: 우선순위(긴급) 반영, 스케일 검증(`--scale worker=3` + 한 대 kill). 
5. README·OpenAPI·compose 최종 검증 (`/verify`, `/submit`).
