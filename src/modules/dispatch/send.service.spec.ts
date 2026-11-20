import { ConfigService } from '@nestjs/config';
import { AlarmRecipientRepository, RecipientSettlePatch } from '../alarm/alarm-recipient.repository';
import { AlarmRecipient } from '../alarm/alarm-recipient.entity';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { AlarmRepository } from '../alarm/alarm.repository';
import { Alarm } from '../alarm/alarm.entity';
import { RecipientStatus } from '../alarm/recipient-status.enum';
import { RateLimiter } from './rate-limiter';
import { SendClient, SendResult } from './send-client';
import { SendService } from './send.service';

// 인프라 없이 claim → call → settle 분기를 검증한다. 리포지토리·클라이언트·리미터는 전부 fake
const ALARM_ID = '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70';
const RECIPIENT = 'u_000001';

function alarm(status = AlarmStatus.SENDING): Alarm {
  const a = Alarm.create(AlarmType.BULK, '제목', '본문');
  a.id = ALARM_ID;
  a.status = status;
  return a;
}

function row(status: RecipientStatus, attemptCount = 0): AlarmRecipient {
  const r = new AlarmRecipient();
  r.alarmId = ALARM_ID;
  r.recipientId = RECIPIENT;
  r.status = status;
  r.attemptCount = attemptCount;
  r.leaseUntil = null;
  return r;
}

class FakeClient implements SendClient {
  sendCalls = 0;
  lookupResult: string | null = null;
  lookupError: Error | null = null;
  constructor(private readonly result: SendResult) {}
  send(): Promise<SendResult> {
    this.sendCalls += 1;
    return Promise.resolve(this.result);
  }
  findMessageIdByClientRef(): Promise<string | null> {
    if (this.lookupError) return Promise.reject(this.lookupError);
    return Promise.resolve(this.lookupResult);
  }
  listUsers(): Promise<{ ids: string[]; nextCursor: string | null }> {
    return Promise.resolve({ ids: [], nextCursor: null });
  }
}

interface Fakes {
  service: SendService;
  client: FakeClient;
  settled: RecipientSettlePatch[];
  limiter: { acquired: number };
  transitions: [AlarmStatus[], AlarmStatus][];
}

function build(options: {
  row: AlarmRecipient | null;
  result?: SendResult;
  alarmStatus?: AlarmStatus;
  claimOk?: boolean;
  reclaimOk?: boolean;
  hasUnsettled?: boolean;
  maxAttempts?: number;
}): Fakes {
  const settled: RecipientSettlePatch[] = [];
  const transitions: [AlarmStatus[], AlarmStatus][] = [];
  const limiter = { acquired: 0 };
  const client = new FakeClient(options.result ?? { kind: 'sent', messageId: 'm_1' });

  const recipientRepo = {
    findOne: () => Promise.resolve(options.row),
    claim: () => Promise.resolve(options.claimOk ?? true),
    reclaimForReconcile: () => Promise.resolve(options.reclaimOk ?? true),
    settle: (_a: string, _r: string, patch: RecipientSettlePatch) => {
      settled.push(patch);
      return Promise.resolve(true);
    },
    hasUnsettled: () => Promise.resolve(options.hasUnsettled ?? true),
  } as unknown as AlarmRecipientRepository;
  const alarmRepo = {
    findById: () => Promise.resolve(alarm(options.alarmStatus ?? AlarmStatus.SENDING)),
    transition: (_id: string, from: AlarmStatus[], to: AlarmStatus) => {
      transitions.push([from, to]);
      return Promise.resolve(true);
    },
  } as unknown as AlarmRepository;
  const rateLimiter: RateLimiter = {
    acquire: () => {
      limiter.acquired += 1;
      return Promise.resolve();
    },
  };
  const config = {
    get: () => ({ maxAttempts: options.maxAttempts ?? 3, leaseSec: 60 }),
  } as unknown as ConfigService<never, true>;

  const service = new SendService(alarmRepo, recipientRepo, client, rateLimiter, config);
  return { service, client, settled, limiter, transitions };
}

const data = { alarmId: ALARM_ID, recipientId: RECIPIENT };

describe('SendService — claim → call → settle', () => {
  it('PENDING 수신자는 토큰을 얻은 뒤 보내고 SENT 로 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'sent', messageId: 'm_9' } });
    const outcome = await f.service.handle(data);
    expect(outcome).toEqual({ action: 'done', reason: 'sent' });
    expect(f.limiter.acquired).toBe(1);
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.SENT, messageId: 'm_9' });
  });

  it('claim 에 실패하면(취소된 알림 등) 보내지 않고 토큰도 쓰지 않는다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), claimOk: false });
    const outcome = await f.service.handle(data);
    expect(outcome).toEqual({ action: 'done', reason: 'claim_rejected' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.limiter.acquired).toBe(0);
  });

  it('이미 SENT/FAILED/CANCELLED 인 행은 아무것도 하지 않는다 (잡 재전달 안전)', async () => {
    for (const status of [RecipientStatus.SENT, RecipientStatus.FAILED, RecipientStatus.CANCELLED]) {
      const f = build({ row: row(status) });
      await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'done' });
      expect(f.client.sendCalls).toBe(0);
    }
  });

  it('400 은 재시도 없이 FAILED(영구) 로 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'permanent', code: 'RECIPIENT_BLOCKED' } });
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'permanent_failure' });
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.FAILED, lastError: 'RECIPIENT_BLOCKED' });
  });

  it('429 는 시도 횟수를 세지 않고 PENDING 으로 되돌린 뒤 전역 일시정지를 요청한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING, 2), result: { kind: 'rate_limited', retryAfterMs: 1000 } });
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'rate_limited', retryAfterMs: 1000 });
    expect(f.settled[0]).toEqual({ status: RecipientStatus.PENDING });
  });

  it('5xx 는 attempt 를 올리고 지수 백오프로 재시도한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING, 1), result: { kind: 'temporary', code: 'INTERNAL_ERROR' } });
    await expect(f.service.handle(data)).resolves.toEqual({
      action: 'retry',
      delayMs: 2000,
      reason: 'temporary_INTERNAL_ERROR',
    });
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.PENDING, attemptCount: 2 });
  });

  it('5xx 가 상한에 도달하면 FAILED 로 끝낸다', async () => {
    const f = build({
      row: row(RecipientStatus.PENDING, 2),
      result: { kind: 'temporary', code: 'SERVICE_UNAVAILABLE' },
      maxAttempts: 3,
    });
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'attempts_exhausted' });
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.FAILED, attemptCount: 3 });
  });

  it('타임아웃은 재전송하지 않고 UNKNOWN 으로 둔 뒤 조회를 예약한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'timeout' } });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'timeout' });
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.UNKNOWN });
    expect(f.client.sendCalls).toBe(1);
  });

  it('마지막 수신자가 끝나면 알림을 SENDING → COMPLETED 로 전이한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), hasUnsettled: false });
    await f.service.handle(data);
    expect(f.transitions).toEqual([[[AlarmStatus.SENDING], AlarmStatus.COMPLETED]]);
  });
});

describe('SendService — 결과 확인(reconcile)', () => {
  it('UNKNOWN 건을 조회해 발송 이력이 있으면 재전송 없이 SENT 로 확정한다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN) });
    f.client.lookupResult = 'm_77';
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'reconciled_sent' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.settled[0]).toMatchObject({ status: RecipientStatus.SENT, messageId: 'm_77' });
  });

  it('이력이 없고 알림이 살아 있으면 그제야 실제로 보낸다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN), result: { kind: 'sent', messageId: 'm_2' } });
    f.client.lookupResult = null;
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'sent' });
    expect(f.client.sendCalls).toBe(1);
  });

  it('이력이 없고 알림이 취소됐으면 보내지 않고 CANCELLED 로 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN), alarmStatus: AlarmStatus.CANCELLED });
    f.client.lookupResult = null;
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'reconciled_cancelled' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.settled[0]).toEqual({ status: RecipientStatus.CANCELLED });
  });

  it('조회 자체가 실패하면 UNKNOWN 을 유지하고 다시 예약한다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN) });
    f.client.lookupError = new Error('boom');
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry' });
    expect(f.settled[0]).toEqual({ status: RecipientStatus.UNKNOWN });
  });

  it('lease 가 살아 있는 PROCESSING(다른 워커 처리 중) 은 건드리지 않고 나중에 다시 본다', async () => {
    const f = build({ row: row(RecipientStatus.PROCESSING), reclaimOk: false });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'processing_elsewhere' });
    expect(f.client.sendCalls).toBe(0);
  });
});
