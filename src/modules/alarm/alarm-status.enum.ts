/**
 * 알림 상태. 전이는 모두 조건부 UPDATE(WHERE status IN from) 로 수행해 동시 요청에서도 한 번만 성공한다.
 *
 *   CREATED ─(발송 시작, API)─▶ PREPARING ─(수신자 적재 완료, 워커)─▶ SENDING ─(전 수신자 종결, 워커)─▶ COMPLETED
 *      └──────────────── (취소, API) ─────────────────┴───────────────────┘──▶ CANCELLED
 */
export enum AlarmStatus {
  CREATED = 'CREATED',
  PREPARING = 'PREPARING',
  SENDING = 'SENDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

// 허용 전이 표. 키 = 목적 상태, 값 = 출발 가능 상태
export const ALARM_TRANSITIONS: Readonly<Record<AlarmStatus, readonly AlarmStatus[]>> = {
  [AlarmStatus.CREATED]: [],
  [AlarmStatus.PREPARING]: [AlarmStatus.CREATED],
  [AlarmStatus.SENDING]: [AlarmStatus.PREPARING],
  [AlarmStatus.COMPLETED]: [AlarmStatus.SENDING],
  [AlarmStatus.CANCELLED]: [AlarmStatus.CREATED, AlarmStatus.PREPARING, AlarmStatus.SENDING],
};

export function canTransition(from: AlarmStatus, to: AlarmStatus): boolean {
  return ALARM_TRANSITIONS[to].includes(from);
}
