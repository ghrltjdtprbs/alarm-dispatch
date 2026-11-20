/**
 * 외부 발송 API 추상화. 워커는 이 인터페이스만 보고, mock HTTP 구현은 MockSendClient 가 한다.
 * 단위 테스트는 fake 구현으로 응답 시나리오(2xx/400/429/5xx/타임아웃)를 주입한다.
 */
export interface SendMessageRequest {
  alarmId: string;
  recipientId: string;
  title: string;
  body: string;
  clientRef: string;
}

export type SendResult =
  | { kind: 'sent'; messageId: string }
  // 400: 수신 거부·없는 수신자·요청 오류. 재시도해도 결과가 같다
  | { kind: 'permanent'; code: string }
  // 429: 보내지지 않았다. retryAfterMs 동안 전역 일시정지
  | { kind: 'rate_limited'; retryAfterMs: number }
  // 5xx: 보내지지 않았다고 본다. 백오프 재시도
  | { kind: 'temporary'; code: string }
  // 응답 없음: 발송됐을 수 있다. clientRef 조회로 확정해야 한다
  | { kind: 'timeout' }
  // 연결 실패 등 요청이 서버에 닿지 않았을 가능성이 높은 오류. 재시도
  | { kind: 'network'; code: string };

export interface UserPage {
  ids: string[];
  nextCursor: string | null;
}

export interface SendClient {
  send(request: SendMessageRequest): Promise<SendResult>;
  // clientRef 로 처리된 발송의 messageId. 없으면 null
  findMessageIdByClientRef(clientRef: string): Promise<string | null>;
  listUsers(cursor: string | null, limit: number): Promise<UserPage>;
}

export const SEND_CLIENT = Symbol('SEND_CLIENT');
