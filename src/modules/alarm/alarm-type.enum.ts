// 알림 종류. URGENT 는 지정 수신자(최대 100명)에게 대량 알림보다 먼저 발송된다 (requirements O-1)
export enum AlarmType {
  BULK = 'BULK',
  URGENT = 'URGENT',
}

export const URGENT_MAX_RECIPIENTS = 100;
