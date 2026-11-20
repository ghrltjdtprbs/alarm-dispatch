import { ALARM_TRANSITIONS, AlarmStatus, canTransition } from './alarm-status.enum';

describe('AlarmStatus 전이 표', () => {
  it('발송 시작은 CREATED 에서만 가능하다', () => {
    expect(canTransition(AlarmStatus.CREATED, AlarmStatus.PREPARING)).toBe(true);
    expect(canTransition(AlarmStatus.SENDING, AlarmStatus.PREPARING)).toBe(false);
    expect(canTransition(AlarmStatus.COMPLETED, AlarmStatus.PREPARING)).toBe(false);
  });

  it('취소는 CREATED/PREPARING/SENDING 에서 가능하고 종료 상태에서는 불가능하다', () => {
    expect(canTransition(AlarmStatus.CREATED, AlarmStatus.CANCELLED)).toBe(true);
    expect(canTransition(AlarmStatus.PREPARING, AlarmStatus.CANCELLED)).toBe(true);
    expect(canTransition(AlarmStatus.SENDING, AlarmStatus.CANCELLED)).toBe(true);
    expect(canTransition(AlarmStatus.COMPLETED, AlarmStatus.CANCELLED)).toBe(false);
    expect(canTransition(AlarmStatus.CANCELLED, AlarmStatus.CANCELLED)).toBe(false);
  });

  it('완료는 SENDING 에서만, 생성 상태로 되돌아가는 전이는 없다', () => {
    expect(ALARM_TRANSITIONS[AlarmStatus.COMPLETED]).toEqual([AlarmStatus.SENDING]);
    expect(ALARM_TRANSITIONS[AlarmStatus.CREATED]).toEqual([]);
  });
});
