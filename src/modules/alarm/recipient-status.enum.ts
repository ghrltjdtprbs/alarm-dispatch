/**
 * 수신자별 발송 상태.
 *
 *   PENDING ─(claim)─▶ PROCESSING ─▶ SENT | FAILED(영구)
 *                          ├─(429 / 5xx 재시도)─▶ PENDING
 *                          └─(타임아웃: 발송됐을 수 있음)─▶ UNKNOWN ─(clientRef 조회)─▶ SENT | PENDING | CANCELLED
 *   PENDING ─(알림 취소)─▶ CANCELLED
 */
export enum RecipientStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  CANCELLED = 'CANCELLED',
}

// 아직 끝나지 않은 상태. 이 상태의 수신자가 0건이면 알림은 COMPLETED
export const UNSETTLED_RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  RecipientStatus.PENDING,
  RecipientStatus.PROCESSING,
  RecipientStatus.UNKNOWN,
];
