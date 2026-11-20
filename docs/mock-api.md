# 외부 발송 mock 서버 동작 요약

- 이미지: `ghcr.io/us-all/backend-assignment-api:1.2` (compose 서비스 `mock`), 컨테이너 포트 **4000** 고정 (`node server.js`)
- 공식 API 문서: 과제 문서의 apidog 링크 (비밀번호 보호). 원문 사본은 `docs/private/` 에만 둔다.
- 아래 내용은 2026-11-20 에 이미지를 직접 띄워 확인한 결과다. 기동 로그:
  `notification-mock :4000 users=100000 blocked=999 rate=50/s error=0.05 timeout=0.02(30000ms) slow=0.05(3000ms) seed=42`
  → 사용자 10만 명, 항상 400 인 수신자 999명, 50 rps, 5% 5xx, 2% 30초 무응답, 5% 3초 지연, seed 고정(재현 가능).

## 엔드포인트 (확인 완료)

| Method | Path | 요청 | 성공 응답 | 비고 |
| --- | --- | --- | --- | --- |
| GET | `/health` | - | `200 {"ok":true}` | compose healthcheck 용 |
| GET | `/v1/users?limit=&cursor=` | `limit` 1~1000 (기본 100), `cursor` 는 이전 응답의 `nextCursor` | `200 {"users":[{"id":"u_000001","name":"...","phone":"010-...."}],"nextCursor":"MTAx"}` | 커서 페이징. 마지막 페이지는 `nextCursor: null`. `cursor` 가 잘못되면 `400 INVALID_CURSOR`. `id` 는 `u_000001`~`u_100000`. 단건 조회(`/v1/users/{id}`)는 없음(404) |
| POST | `/v1/messages` | `{"alarmId": string, "recipientId": string, "body": string, "clientRef"?: string, "title"?: string}` | `202 {"messageId":"m_1"}` | `alarmId`/`recipientId`/`body` 필수(없으면 `400 INVALID_REQUEST`). `title` 은 보내도 무시되지 않고 받아들여짐(필수 아님) |
| GET | `/v1/messages?clientRef=` | `clientRef` 필수 | `200 {"messages":[{"messageId":"m_1","recipientId":"u_000001","sentAt":"ISO"}]}` | **같은 clientRef 로 처리된 발송 이력 조회**. 없으면 `messages: []`. 타임아웃 뒤 "실제로 보내졌는지" 확인하는 용도로 쓴다 |

### 발송 오류 응답

| HTTP | body `code` | 의미 | 처리 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 필수 필드 누락 | 우리 버그. 영구 실패 + 에러 로그 |
| 400 | `UNKNOWN_RECIPIENT` | 존재하지 않는 수신자 | 영구 실패 |
| 400 | `RECIPIENT_BLOCKED` | 수신 거부(opted out) 사용자, 항상 400 (999명, 예: `u_000089`) | 영구 실패. 재시도 금지 |
| 429 | `RATE_LIMITED` | 초당 50건 초과. 헤더 `retry-after: 1` (초) | 전역 일시정지 후 재시도. 실패 카운트에 넣지 않음 |
| 500 | `INTERNAL_ERROR` | 일시 오류 ("temporary failure") | 백오프 재시도 |
| 503 | `SERVICE_UNAVAILABLE` | 일시 오류 | 백오프 재시도 |
| (무응답) | - | 약 2%: **발송은 처리됨**, 30초 뒤에도 응답 없음 | 타임아웃으로 끊고 `GET /v1/messages?clientRef=` 로 처리 여부 확인 후 재시도 여부 결정 |

## 동작 특성과 설계 시사점

| 특성 | 확인 결과 | 설계 시사점 |
| --- | --- | --- |
| 처리량 제한 | 120건 동시 요청 시 6건 429, `retry-after: 1` | 워커 수와 무관한 전역 제한(Redis 토큰 버킷). 긴급/대량이 한 버킷 공유 |
| 일시 오류 | 5xx 약 5% (`INTERNAL_ERROR`/`SERVICE_UNAVAILABLE`) | 지수 백오프 재시도, 횟수 상한 |
| 타임아웃 | 약 2% 가 발송은 처리되지만 30초 무응답 | `SEND_REQUEST_TIMEOUT_MS` 로 짧게 끊고 "보냈을 수 있음" 상태로 둔 뒤 clientRef 조회로 확정 |
| 지연 | 약 5% 가 3초 지연 | 타임아웃은 3초보다 넉넉히(기본 5초). in-flight 수 제한 |
| 영구 실패 | `RECIPIENT_BLOCKED` 999명 고정, `UNKNOWN_RECIPIENT` | 재시도 없이 즉시 영구 실패 |
| 중복 제거 | 없음. 같은 `clientRef` 로 다시 POST 하면 새 `messageId` 로 또 발송되고 조회 시 2건 나옴 | 멱등성은 우리 쪽 책임. `clientRef` 는 `{alarmId}:{recipientId}` 처럼 결정적으로 만들어 조회 키로 쓴다 |
| 사용자 API | 커서 페이징, 페이지당 최대 1000 → 10만 명 = 100회 호출 | 수신자 스냅샷 적재 시 limit=1000 으로 순회 |
| 재현성 | `seed=42` 고정 | 어떤 수신자가 blocked 인지, 어떤 요청이 실패할지는 매 기동마다 같은 패턴 |
