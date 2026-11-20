import { AlarmType } from '../alarm/alarm-type.enum';
import { JOB_PRIORITY, prepareJobId, retryPriority, sendJobId } from './dispatch-job';

describe('dispatch-job 우선순위·jobId', () => {
  it('긴급은 적재·발송 모두 대량보다 먼저 처리된다 (숫자가 작을수록 우선)', () => {
    expect(JOB_PRIORITY[AlarmType.URGENT].send).toBeLessThan(JOB_PRIORITY[AlarmType.BULK].prepare);
    expect(JOB_PRIORITY[AlarmType.BULK].prepare).toBeLessThan(JOB_PRIORITY[AlarmType.BULK].send);
  });

  it('재시도로 돌아오는 대량 잡은 대량 발송보다 앞, 긴급보다 뒤에 선다', () => {
    const bulkRetry = retryPriority(JOB_PRIORITY[AlarmType.BULK].send);
    expect(bulkRetry).toBeLessThan(JOB_PRIORITY[AlarmType.BULK].send);
    expect(bulkRetry).toBeGreaterThan(JOB_PRIORITY[AlarmType.URGENT].send);
    expect(retryPriority(JOB_PRIORITY[AlarmType.URGENT].send)).toBe(JOB_PRIORITY[AlarmType.URGENT].send);
    expect(retryPriority(undefined)).toBe(JOB_PRIORITY[AlarmType.BULK].prepare);
  });

  it('jobId 는 결정적이고 콜론을 쓰지 않는다 (BullMQ 제약)', () => {
    expect(sendJobId('a', 'u_1')).toBe('send-a-u_1');
    expect(prepareJobId('a')).toBe('prepare-a');
    expect(sendJobId('a', 'u_1')).not.toContain(':');
  });
});
