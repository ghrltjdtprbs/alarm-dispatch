import { Alarm } from '../src/modules/alarm/alarm.entity';
import { AlarmRepository } from '../src/modules/alarm/alarm.repository';
import { AlarmRecipientRepository } from '../src/modules/alarm/alarm-recipient.repository';
import { AlarmStatus } from '../src/modules/alarm/alarm-status.enum';
import { AlarmType } from '../src/modules/alarm/alarm-type.enum';
import { RecipientStatus } from '../src/modules/alarm/recipient-status.enum';
import { runConcurrently } from './support/concurrency.support';
import { createTestApp, TestContext } from './support/integration-test.support';

// 워커 파이프라인의 조건부 UPDATE(claim / settle / reclaim) 가 실제 PostgreSQL 에서 한 번만 성공하는지 검증한다
describe('AlarmRecipientRepository (e2e)', () => {
  let ctx: TestContext;
  let alarms: AlarmRepository;
  let recipients: AlarmRecipientRepository;

  const future = (): Date => new Date(Date.now() + 60_000);
  const past = (): Date => new Date(Date.now() - 1_000);

  const createAlarm = async (status: AlarmStatus, recipientIds: string[]): Promise<Alarm> => {
    const alarm = await alarms.save(Alarm.create(AlarmType.BULK, 't', 'b'));
    if (status !== AlarmStatus.CREATED) await alarms.transition(alarm.id, [AlarmStatus.CREATED], status);
    await recipients.insertPendingIgnoreDuplicates(alarm.id, recipientIds);
    return alarm;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    alarms = ctx.app.get(AlarmRepository);
    recipients = ctx.app.get(AlarmRecipientRepository);
  });

  beforeEach(() => ctx.truncateAll());
  afterAll(() => ctx.close());

  it('수신자 적재는 재실행해도 중복 행을 만들지 않는다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, ['u_1', 'u_2']);
    await recipients.insertPendingIgnoreDuplicates(alarm.id, ['u_2', 'u_3']);
    expect((await recipients.countByStatus(alarm.id))[RecipientStatus.PENDING]).toBe(3);
  });

  it('claim 은 발송 가능한 알림의 PENDING 행만 점유하고, 같은 행에 대한 동시 claim 은 하나만 성공한다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, ['u_1']);
    const result = await runConcurrently(8, async () => {
      if (!(await recipients.claim(alarm.id, 'u_1', future()))) throw new Error('rejected');
    });
    expect(result.successCount).toBe(1);
    expect((await recipients.findOne(alarm.id, 'u_1'))?.status).toBe(RecipientStatus.PROCESSING);
  });

  it('취소된 알림의 수신자는 claim 되지 않는다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, ['u_1']);
    await alarms.transition(alarm.id, [AlarmStatus.SENDING], AlarmStatus.CANCELLED);
    expect(await recipients.claim(alarm.id, 'u_1', future())).toBe(false);
  });

  it('settle 은 내 lease(펜스) 로 점유한 PROCESSING 행만 바꾸고 lease 를 비운다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, ['u_1', 'u_2']);
    const lease = future();
    await recipients.claim(alarm.id, 'u_1', lease);
    // 다른 펜스(다른 워커의 점유라고 가정) 로는 기록할 수 없다
    expect(await recipients.settle(alarm.id, 'u_1', past(), { status: RecipientStatus.SENT, messageId: 'm_x' })).toBe(
      false,
    );
    expect(await recipients.settle(alarm.id, 'u_1', lease, { status: RecipientStatus.SENT, messageId: 'm_1' })).toBe(
      true,
    );
    expect(await recipients.settle(alarm.id, 'u_2', lease, { status: RecipientStatus.SENT })).toBe(false);
    const row = await recipients.findOne(alarm.id, 'u_1');
    expect(row).toMatchObject({ status: RecipientStatus.SENT, messageId: 'm_1', leaseUntil: null });
  });

  it('reclaim 은 UNKNOWN 과 lease 만료 PROCESSING 만 다시 점유하고, lease 가 살아 있으면 거절한다', async () => {
    const alarm = await createAlarm(AlarmStatus.CANCELLED, ['u_unknown', 'u_live', 'u_dead']);
    await ctx.dataSource.query(
      `UPDATE alarm_recipients SET status = CASE recipient_id WHEN 'u_unknown' THEN 'UNKNOWN' ELSE 'PROCESSING' END,
              lease_until = CASE recipient_id WHEN 'u_live' THEN $1::timestamptz WHEN 'u_dead' THEN $2::timestamptz END
        WHERE alarm_id = $3`,
      [future(), past(), alarm.id],
    );
    expect(await recipients.reclaimForReconcile(alarm.id, 'u_unknown', future())).toBe(true);
    expect(await recipients.reclaimForReconcile(alarm.id, 'u_dead', future())).toBe(true);
    expect(await recipients.reclaimForReconcile(alarm.id, 'u_live', future())).toBe(false);
  });

  it('findRecoverable 은 lease 만료 PROCESSING·오래된 UNKNOWN/PENDING 만 돌려준다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, [
      'u_dead',
      'u_live',
      'u_old_unknown',
      'u_fresh_pending',
      'u_sent',
    ]);
    await ctx.dataSource.query(
      `UPDATE alarm_recipients SET
         status = CASE recipient_id WHEN 'u_dead' THEN 'PROCESSING' WHEN 'u_live' THEN 'PROCESSING'
                                    WHEN 'u_old_unknown' THEN 'UNKNOWN' WHEN 'u_sent' THEN 'SENT' ELSE status END,
         lease_until = CASE recipient_id WHEN 'u_dead' THEN $1::timestamptz WHEN 'u_live' THEN $2::timestamptz END,
         updated_at = CASE recipient_id WHEN 'u_old_unknown' THEN now() - interval '10 minutes' ELSE now() END
       WHERE alarm_id = $3`,
      [past(), future(), alarm.id],
    );
    const found = (await recipients.findRecoverable(120, 3600, 100)).map((r) => r.recipientId).sort();
    expect(found).toEqual(['u_dead', 'u_old_unknown']);
  });

  it('취소된 알림은 결과 확인이 필요한 PROCESSING/UNKNOWN 만 복구 대상이고 PENDING 은 제외한다', async () => {
    const alarm = await createAlarm(AlarmStatus.CANCELLED, ['u_pending', 'u_unknown']);
    await ctx.dataSource.query(
      `UPDATE alarm_recipients SET status = CASE recipient_id WHEN 'u_unknown' THEN 'UNKNOWN' ELSE status END,
              updated_at = now() - interval '10 minutes' WHERE alarm_id = $1`,
      [alarm.id],
    );
    const found = (await recipients.findRecoverable(120, 0, 100)).map((r) => r.recipientId);
    expect(found).toEqual(['u_unknown']);
  });

  it('cancelPending 은 PENDING 만 취소하고 hasUnsettled 는 미종결 여부를 알려준다', async () => {
    const alarm = await createAlarm(AlarmStatus.SENDING, ['u_1', 'u_2']);
    const lease = future();
    await recipients.claim(alarm.id, 'u_1', lease);
    expect(await recipients.cancelPending(alarm.id)).toBe(1);
    expect(await recipients.hasUnsettled(alarm.id)).toBe(true);
    await recipients.settle(alarm.id, 'u_1', lease, { status: RecipientStatus.FAILED, lastError: 'X' });
    expect(await recipients.hasUnsettled(alarm.id)).toBe(false);
    // 종료된 알림에 뒤늦게 남은 PENDING 은 cancelIfPending 으로 정리된다
    await recipients.insertPendingIgnoreDuplicates(alarm.id, ['u_late']);
    expect(await recipients.cancelIfPending(alarm.id, 'u_late')).toBe(true);
    expect(await recipients.cancelIfPending(alarm.id, 'u_late')).toBe(false);
  });
});
