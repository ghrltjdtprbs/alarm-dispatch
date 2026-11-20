# alarm-dispatch

약 10만 명의 수신자에게 알림을 보내는 발송 시스템입니다.

API 서버는 알림을 만들고 조회하고 발송을 시작·취소하는 역할만 합니다. 실제 발송은 별도의 워커 프로세스가 맡아서, 외부 발송 API의 처리량 제한(초당 50건)과 일시 오류, 타임아웃, 수신 거부 같은 상황을 처리하면서 수신자 한 명씩 보냅니다.

| 구분 | 선택 | 이유 |
| --- | --- | --- |
| 언어 / 프레임워크 | TypeScript, NestJS 11 | 과제 요구사항 |
| DB | PostgreSQL 16, TypeORM | 조건부 UPDATE와 유니크 제약, `ON CONFLICT DO NOTHING`으로 정합성을 DB에 맡길 수 있습니다. TypeORM은 NestJS 통합과 마이그레이션 CLI가 있습니다 |
| 큐 | Redis 7, BullMQ | 워커 간 잡 분배, 우선순위, 지연 재시도, 멈춘 잡 복구가 내장되어 있습니다 |
| 처리량 제한 | Redis Lua 토큰 버킷 | 워커 수와 무관하게 전역으로 초당 호출 수를 제한할 수 있습니다 |
| HTTP 클라이언트 | Node 내장 fetch | 의존성 없이 타임아웃을 걸 수 있습니다 |
| 문서 / 테스트 | Swagger(OpenAPI 3.0), Jest, supertest | NestJS 기본 구성입니다 |

## 실행하기

Docker Compose만 있으면 됩니다. 테스트를 로컬에서 돌리려면 Node 20 이상이 필요합니다.

```bash
cp .env.sample .env          # 생략해도 기본값으로 동작합니다
docker compose up --build
```

올라오는 서비스는 `api`(3000 포트), `worker`, `mock`(외부 발송 API), `postgres`, `redis` 다섯 개입니다. postgres와 redis가 준비되면 api가 뜨면서 마이그레이션을 적용하고, api가 정상 응답하기 시작하면 worker가 뜹니다.

- Swagger UI: http://localhost:3000/docs
- OpenAPI JSON: http://localhost:3000/docs-json (파일로는 `docs/openapi.json`)

워커를 여러 대 띄우려면:

```bash
docker compose up --scale worker=3
```

테스트:

```bash
npm install
npm test                                                       # 단위 테스트
docker compose up -d postgres redis mock && npm run test:e2e   # e2e
```

### 환경변수

전체 목록과 설명은 `.env.sample`에 있습니다. 발송 동작에 영향을 주는 값은 다음과 같습니다.

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `SEND_RATE_LIMIT_PER_SEC` | 45 | 외부 API 호출 상한. 워커가 몇 대든 합산으로 적용됩니다 |
| `SEND_REQUEST_TIMEOUT_MS` | 5000 | 외부 API 요청 타임아웃 |
| `SEND_MAX_ATTEMPTS` | 5 | 5xx 응답 재시도 상한 |
| `SEND_RECONCILE_DELAY_MS` | 5000 | 타임아웃 뒤 발송 여부를 조회하기까지 대기 |
| `SEND_LEASE_SEC` | 60 | 수신자 한 명을 점유하는 시간. 지나도 처리 중이면 워커가 죽은 것으로 봅니다 |
| `WORKER_CONCURRENCY` | 25 | 워커 한 대가 동시에 처리하는 수 |

## API

기본 경로는 `/api/v1`입니다. 모든 응답은 아래 형태로 감싸져 있고 `code`는 HTTP 상태 코드와 같습니다.

```json
{ "code": 200, "message": null, "data": { ... } }
{ "code": 409, "message": "SENDING 상태의 알림은 발송 시작할 수 없습니다.", "data": null, "error": { "code": "ALARM_INVALID_STATUS" } }
```

| Method | Path | 설명 | 응답 |
| --- | --- | --- | --- |
| POST | `/alarms` | 알림 생성 | 201 |
| GET | `/alarms` | 알림 목록 (`page`, `size`, `status`, `type`) | 200 |
| GET | `/alarms/{id}` | 알림 단건과 발송 진행 상황 | 200 |
| POST | `/alarms/{id}/send` | 발송 시작 | 202 |
| POST | `/alarms/{id}/cancel` | 발송 취소 | 200 |
| GET | `/alarms/{id}/recipients` | 수신자별 발송 상태 (`status` 필터) | 200 |

오류는 상황에 따라 400(검증 실패), 404(없는 알림), 409(허용되지 않는 상태 전이)로 나뉩니다. 에러 코드 목록은 `src/common/exception/error-code.ts`에 모여 있습니다.

### 사용 예시

알림을 만들고 발송을 시작합니다.

```bash
curl -X POST localhost:3000/api/v1/alarms \
  -H 'content-type: application/json' \
  -d '{"title":"점검 안내","body":"11월 25일 02:00~04:00 서비스 점검이 있습니다."}'

curl -X POST localhost:3000/api/v1/alarms/{id}/send
```

`type`을 생략하면 전체 사용자에게 보내는 대량 알림(BULK)입니다. 지정한 수신자에게만 먼저 보내는 긴급 알림은 `URGENT`로 만들고 수신자를 1~100명 넘깁니다.

```bash
curl -X POST localhost:3000/api/v1/alarms \
  -H 'content-type: application/json' \
  -d '{"type":"URGENT","title":"인증번호","body":"123456","recipientIds":["u_000001","u_000002"]}'
```

진행 상황은 단건 조회의 `progress`로 봅니다. 수신자 상태별 건수이고 `total`은 그 합입니다.

```json
{
  "code": 200,
  "message": null,
  "data": {
    "id": "9323718e-...",
    "type": "BULK",
    "title": "점검 안내",
    "status": "SENDING",
    "progress": { "total": 100000, "pending": 65333, "processing": 33, "sent": 34285, "failed": 348, "unknown": 1, "cancelled": 0 }
  }
}
```

실패한 수신자만 보고 싶으면 수신자 목록에 필터를 줍니다.

```bash
curl 'localhost:3000/api/v1/alarms/{id}/recipients?status=FAILED'
```

## 설계 설명

### 상태 모델

알림과 수신자를 따로 둡니다. `alarms`에는 알림 자체의 상태가, `alarm_recipients`에는 수신자 한 명마다 발송 상태가 있습니다. 수신자 테이블은 `(alarm_id, recipient_id)`가 유니크라 적재를 몇 번 다시 해도 중복 행이 생기지 않습니다.

알림 상태는 네 단계로 흐르고, 끝나기 전이면 어디서든 취소할 수 있습니다.

```
CREATED → PREPARING → SENDING → COMPLETED
    └─────────┴──────────┴──────→ CANCELLED
```

- `CREATED → PREPARING` 발송 시작 API가 바꿉니다.
- `PREPARING → SENDING` 워커가 수신자 적재를 끝내면 바꿉니다.
- `SENDING → COMPLETED` 마지막 수신자가 종결되는 순간 바꿉니다. 성공률과 상관없이 모두 종결되면 완료입니다. 일부 수신자는 항상 400이기 때문에 "전원 성공"은 기준이 될 수 없습니다.

수신자 상태는 아래처럼 움직입니다.

```
PENDING → PROCESSING → SENT | FAILED
              ├─ 429, 5xx ──→ PENDING (재시도)
              └─ 타임아웃 ──→ UNKNOWN → 발송 여부 조회 → SENT | 재발송 | CANCELLED
PENDING → CANCELLED (알림 취소)
```

모든 상태 변경은 `UPDATE ... WHERE status = ?` 형태의 조건부 UPDATE로만 합니다. 읽고 판단하고 쓰는 과정이 없으니 API와 워커, 워커와 워커가 동시에 같은 행을 건드려도 한쪽만 성공하고, 별도의 락이 필요하지 않습니다.

### 발송 흐름

```
1. API    발송 시작 요청 → 알림을 PREPARING으로 → 큐에 prepare 잡 하나
2. Worker prepare 잡: 사용자 API를 1000명씩 커서로 읽어 수신자를 적재하고,
          페이지마다 send 잡 1000개를 큐에 넣음 → 끝나면 SENDING
3. Worker send 잡(수신자 1명):
     claim   PENDING → PROCESSING. 알림이 PREPARING/SENDING일 때만 성공
     call    토큰 버킷에서 토큰을 받아 외부 API 호출
     settle  결과를 조건부 UPDATE로 기록. 미종결이 0건이면 알림을 COMPLETED로
```

외부 API 호출은 트랜잭션 밖에서 합니다. claim과 settle만 각각 짧은 UPDATE입니다.

잡은 수신자 한 명 단위입니다. 배치로 묶으면 느린 응답 하나가 배치 전체를 막고 워커가 죽었을 때 배치 전체를 다시 확인해야 하지만, 한 명 단위면 재시도와 복구가 그 수신자에만 미칩니다.

외부 API 응답은 이렇게 처리합니다.

| 응답 | 처리 |
| --- | --- |
| 202 | SENT로 기록 |
| 400 | FAILED. 수신 거부 같은 영구 실패라 재시도하지 않습니다 |
| 429 | 보내지지 않은 것으로 보고 PENDING으로 되돌립니다. Retry-After 동안 모든 워커의 호출을 멈춥니다. 재시도 횟수에는 세지 않습니다 |
| 500, 503 | 1초, 2초, 4초 … 지수 백오프로 재시도하고 5회째 실패하면 FAILED |
| 타임아웃, 소켓 끊김 | 서버가 처리했을 수 있으므로 재전송하지 않고 UNKNOWN으로 둡니다. 5초 뒤 `clientRef`로 발송 여부를 조회해서 있으면 SENT, 없으면 그때 다시 보냅니다. 연결 거부처럼 서버에 닿지 않은 것이 확실한 오류만 5xx와 같이 바로 재시도합니다 |

`clientRef`는 `{alarmId}:{recipientId}`로 고정합니다. mock은 같은 clientRef를 다시 보내면 그대로 한 번 더 발송하므로 중복 방지는 우리 상태 테이블의 몫이고, clientRef는 타임아웃 뒤에 "실제로 나갔는지" 되묻는 키로 씁니다. BullMQ의 jobId도 같은 규칙으로 만들어서 한 수신자의 잡이 두 번 들어가지 않습니다.

### 처리량 제한

Redis에 토큰 버킷을 하나 두고 Lua 스크립트로 토큰을 꺼냅니다. 보충과 차감이 한 스크립트에서 원자적으로 일어나기 때문에 워커가 여러 대여도 합산 초당 45건을 넘지 않습니다. 버킷 용량은 rate의 10%로 작게 잡아서 어느 1초 구간을 잡아도 50건을 넘지 않습니다. 긴급 알림과 대량 알림이 같은 버킷을 씁니다.

토큰은 발송 요청(`POST /v1/messages`) 직전에만 꺼냅니다. 제한 대상이 아닌 사용자 목록 조회와 발송 내역 조회, 취소된 알림의 빈 잡은 한도를 소모하지 않습니다. 429를 받으면 Retry-After를 같은 키에 기록해서 모든 워커의 호출이 함께 멈춥니다.

### 동시성과 장애

| 상황 | 대응 |
| --- | --- |
| 발송 시작을 동시에 여러 번 | 조건부 UPDATE에 성공한 한 요청만 큐에 넣고, 나머지는 409 |
| 발송 시작과 취소가 동시에 | 둘 다 조건부 UPDATE. 워커는 claim할 때 알림 상태를 다시 확인하므로 취소 뒤에는 보내지 않습니다 |
| 같은 수신자를 두 워커가 | BullMQ 잡 lock이 1차, 수신자 행의 조건부 UPDATE가 2차입니다. claim 때 받은 `lease_until`을 펜스로 써서, 멈췄다가 늦게 깨어난 워커는 보내지도 기록하지도 못합니다 |
| 발송 중 취소 | 아직 대기 중인 수신자는 CANCELLED, 호출 중인 건은 결과대로 기록합니다. 이미 외부로 나간 발송은 되돌릴 수 없습니다 |
| 워커가 죽었을 때 | SIGTERM이면 진행 중인 잡을 끝내고 종료합니다. 강제 종료면 BullMQ가 stalled 잡을 다른 워커에 넘기고, lease가 만료된 행은 발송 여부 조회를 거쳐 처리합니다 |
| 큐가 비워졌을 때 | 주기 스윕이 DB 기준으로 미종결 수신자를 다시 큐에 넣습니다. 상태의 진실은 DB에 있어서 Redis가 날아가도 이어서 보낼 수 있습니다 |

### 긴급 알림과 워커 다중화

긴급 알림은 같은 큐에서 BullMQ priority로 앞에 섭니다(긴급 1~2, 대량 5~10). 대량 발송을 수신자 한 명 단위의 잡으로 쪼개 두었기 때문에 10만 건이 진행 중이어도 긴급 잡이 바로 다음 순서에 끼어듭니다. 재시도로 잠시 지연됐다가 돌아오는 대량 잡은 대량 대기열 맨 뒤로 가지 않도록 우선순위를 5로 올려 둡니다.

워커를 여러 대 띄우면 BullMQ가 잡 단위로 분배합니다. 처리량 제한은 Redis에 하나뿐이라 워커 수와 상관없고, 중복 방지는 수신자 행의 조건부 UPDATE가 맡습니다. 마이그레이션은 api 한 프로세스만 적용하고 worker는 api가 정상 응답한 뒤에 뜨도록 해서, 여러 워커가 동시에 스키마를 만들며 충돌하는 일을 피했습니다.

## 가정과 해석

과제에 명시되지 않아 다음과 같이 정했습니다.

- 생성 직후 상태는 CREATED이고, 완료는 모든 수신자가 종결된 시점입니다.
- 취소하면 아직 보내지 않은 수신자만 CANCELLED가 되고 이미 보낸 건은 SENT로 남습니다.
- 대량 알림의 수신자는 발송 시작 시점에 워커가 적재합니다. 10만 건 적재에 수십 초가 걸려서 API 요청 안에서 하지 않았습니다.
- 발송 시작 응답은 비동기 수락이므로 202입니다.
- 긴급 알림의 수신자는 mock 사용자 id 목록으로 받습니다. 단건 조회 API가 없어 존재 여부는 발송 시점에 mock이 판정합니다.
- 처리량은 10% 마진을 두어 45 rps로 잡았습니다.
- mock을 직접 호출해 확인한 것: 타임아웃되는 요청도 수신 즉시 기록되고, 5xx 응답은 기록되지 않습니다. 그래서 5xx는 바로 재시도하고 타임아웃은 조회를 거칩니다.
