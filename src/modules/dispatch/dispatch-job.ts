import { AlarmType } from '../alarm/alarm-type.enum';

// 발송 큐 이름. API(producer) 와 워커(consumer) 가 같은 큐를 본다
export const DISPATCH_QUEUE = 'dispatch';

export enum DispatchJobName {
  // 수신자 적재 + send 잡 투입 (알림당 1개)
  PREPARE = 'prepare',
  // 수신자 1명 발송
  SEND = 'send',
}

export interface PrepareJobData {
  alarmId: string;
  type: AlarmType;
}

export interface SendJobData {
  alarmId: string;
  recipientId: string;
}

// BullMQ 는 숫자가 작을수록 먼저 처리한다. 긴급 알림은 적재·발송 모두 대량보다 앞선다 (requirements O-1)
export const JOB_PRIORITY: Readonly<Record<AlarmType, { prepare: number; send: number }>> = {
  [AlarmType.URGENT]: { prepare: 1, send: 2 },
  [AlarmType.BULK]: { prepare: 5, send: 10 },
};

// 커스텀 jobId 는 ':' 를 쓸 수 없다. 같은 수신자 잡이 두 번 들어가지 않도록 결정적으로 만든다
export function prepareJobId(alarmId: string): string {
  return `prepare-${alarmId}`;
}

export function sendJobId(alarmId: string, recipientId: string): string {
  return `send-${alarmId}-${recipientId}`;
}
