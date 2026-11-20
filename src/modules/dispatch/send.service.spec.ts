import { ConfigService } from '@nestjs/config';

import { Alarm } from '../alarm/alarm.entity';
import { AlarmRepository } from '../alarm/alarm.repository';
import { AlarmRecipient } from '../alarm/alarm-recipient.entity';
import { AlarmRecipientRepository, RecipientSettlePatch } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { RecipientStatus } from '../alarm/recipient-status.enum';
import { RateLimiter } from './rate-limiter';
import { SendService } from './send.service';
import { SendClient, SendResult } from './send-client';

// 인프라 없이 claim → call → settle 분기를 검증한다. 리포지토리·클라이언트·리미터는 전부 fake
const ALARM_ID = '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70';
const RECIPIENT = 'u_000001';
const LEASE_SEC = 60;

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

type RecipientRepoFake = Pick<
  AlarmRecipientRepository,
  'findOne' | 'claim' | 'reclaimForReconcile' | 'settle' | 'hasUnsettled' | 'cancelIfPending'
>;
type AlarmRepoFake = Pick<AlarmRepository, 'findById' | 'transition'>;

interface Fakes {
  service: SendService;
  client: FakeClient;
  settled: { fence: Date; patch: RecipientSettlePatch }[];
  limiter: { acquired: number; pausedMs: number[] };
  transitions: [readonly AlarmStatus[], AlarmStatus][];
  cancelledIfPending: string[];
  claimedFences: Date[];
}

function build(options: {
  row: AlarmRecipient | null;
  result?: SendResult;
  alarmStatus?: AlarmStatus;
  claimOk?: boolean;
  reclaimOk?: boolean;
  settleOk?: boolean;
  hasUnsettled?: boolean;
  maxAttempts?: number;
  leaseSec?: number;
}): Fakes {
  const settled: Fakes['settled'] = [];
  const transitions: Fakes['transitions'] = [];
  const cancelledIfPending: string[] = [];
  const claimedFences: Date[] = [];
  const limiter = { acquired: 0, pausedMs: [] as number[] };
  const client = new FakeClient(options.result ?? { kind: 'sent', messageId: 'm_1' });

  const recipientRepo: RecipientRepoFake = {
    findOne: () => Promise.resolve(options.row),
    claim: (_a, _r, lease) => {
      claimedFences.push(lease);
      return Promise.resolve(options.claimOk ?? true);
    },
    reclaimForReconcile: (_a, _r, lease) => {
      claimedFences.push(lease);
      return Promise.resolve(options.reclaimOk ?? true);
    },
    settle: (_a, _r, fence, patch) => {
      settled.push({ fence, patch });
      return Promise.resolve(options.settleOk ?? true);
    },
    hasUnsettled: () => Promise.resolve(options.hasUnsettled ?? true),
    cancelIfPending: (_a, r) => {
      cancelledIfPending.push(r);
      return Promise.resolve(true);
    },
  };
  const alarmRepo: AlarmRepoFake = {
    findById: () => Promise.resolve(alarm(options.alarmStatus ?? AlarmStatus.SENDING)),
    transition: (_id, from, to) => {
      transitions.push([from, to]);
      return Promise.resolve(true);
    },
  };
  const rateLimiter: RateLimiter = {
    acquire: () => {
      limiter.acquired += 1;
      return Promise.resolve();
    },
    pause: (ms) => {
      limiter.pausedMs.push(ms);
      return Promise.resolve();
    },
  };
  const config = {
    get: () => ({
      maxAttempts: options.maxAttempts ?? 3,
      leaseSec: options.leaseSec ?? LEASE_SEC,
      reconcileDelayMs: 5000,
    }),
  } as unknown as ConfigService<never, true>;

  const service = new SendService(
    alarmRepo as AlarmRepository,
    recipientRepo as AlarmRecipientRepository,
    client,
    rateLimiter,
    config,
  );
  return { service, client, settled, limiter, transitions, cancelledIfPending, claimedFences };
}

const data = { alarmId: ALARM_ID, recipientId: RECIPIENT };

describe('SendService — claim → call → settle', () => {
  it('PENDING 수신자는 토큰을 얻은 뒤 보내고, claim 때 받은 lease 를 펜스로 SENT 를 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'sent', messageId: 'm_9' } });
    const outcome = await f.service.handle(data);
    expect(outcome).toEqual({ action: 'done', reason: 'sent' });
    expect(f.limiter.acquired).toBe(1);
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.SENT, messageId: 'm_9' });
    expect(f.settled[0].fence).toBe(f.claimedFences[0]);
  });

  it('claim 에 실패하면 보내지 않고 토큰도 쓰지 않는다. 알림이 끝난 상태면 PENDING 잔여 행을 CANCELLED 로 정리한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), claimOk: false, alarmStatus: AlarmStatus.CANCELLED });
    const outcome = await f.service.handle(data);
    expect(outcome).toMatchObject({ action: 'done', reason: 'claim_rejected' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.limiter.acquired).toBe(0);
    expect(f.cancelledIfPending).toEqual([RECIPIENT]);
  });

  it('claim 에 실패했지만 알림이 살아 있으면(다른 실행이 먼저 잡음) 아무것도 바꾸지 않는다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), claimOk: false, alarmStatus: AlarmStatus.SENDING });
    await f.service.handle(data);
    expect(f.cancelledIfPending).toEqual([]);
    expect(f.settled).toHaveLength(0);
  });

  it('이미 SENT/FAILED/CANCELLED 인 행은 아무것도 하지 않는다 (잡 재전달 안전)', async () => {
    for (const status of [RecipientStatus.SENT, RecipientStatus.FAILED, RecipientStatus.CANCELLED]) {
      const f = build({ row: row(status) });
      await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'done', reason: 'already_settled' });
      expect(f.client.sendCalls).toBe(0);
      expect(f.settled).toHaveLength(0);
      expect(f.transitions).toHaveLength(0);
    }
  });

  it('400 은 재시도 없이 FAILED(영구) 로 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'permanent', code: 'RECIPIENT_BLOCKED' } });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'done', reason: 'permanent_failure' });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.FAILED, lastError: 'RECIPIENT_BLOCKED' });
  });

  it('429 는 시도 횟수를 세지 않고 PENDING 으로 되돌린 뒤 토큰 버킷을 Retry-After 만큼 전역 일시정지한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING, 2), result: { kind: 'rate_limited', retryAfterMs: 1000 } });
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'retry', delayMs: 1000, reason: 'rate_limited' });
    expect(f.settled[0].patch).toEqual({ status: RecipientStatus.PENDING });
    expect(f.limiter.pausedMs).toEqual([1000]);
  });

  it('5xx 는 attempt 를 올리고 지수 백오프로 재시도한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING, 1), result: { kind: 'temporary', code: 'INTERNAL_ERROR' } });
    await expect(f.service.handle(data)).resolves.toEqual({
      action: 'retry',
      delayMs: 2000,
      reason: 'temporary_failure',
      code: 'INTERNAL_ERROR',
    });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.PENDING, attemptCount: 2 });
  });

  it('5xx 가 상한에 도달하면 FAILED 로 끝낸다', async () => {
    const f = build({
      row: row(RecipientStatus.PENDING, 2),
      result: { kind: 'temporary', code: 'SERVICE_UNAVAILABLE' },
      maxAttempts: 3,
    });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'done', reason: 'attempts_exhausted' });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.FAILED, attemptCount: 3 });
  });

  it('연결 거부(ECONNREFUSED) 는 서버에 닿지 않은 것이므로 그냥 재시도한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'network', code: 'ECONNREFUSED' } });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'temporary_failure' });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.PENDING, attemptCount: 1 });
  });

  it('소켓 끊김 같은 네트워크 오류는 처리됐을 수 있으므로 타임아웃처럼 UNKNOWN 으로 두고 조회한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'network', code: 'UND_ERR_SOCKET' } });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'timeout' });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.UNKNOWN });
  });

  it('타임아웃은 재전송하지 않고 UNKNOWN 으로 둔 뒤 조회를 예약한다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), result: { kind: 'timeout' } });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', delayMs: 5000, reason: 'timeout' });
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.UNKNOWN });
    expect(f.client.sendCalls).toBe(1);
  });

  it('토큰을 기다리다 lease 가 거의 끝났으면 보내지 않는다 (다른 워커가 reclaim 할 수 있어 중복 위험)', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), leaseSec: 1 });
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'lease_expired' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.settled).toHaveLength(0);
  });

  it('settle 이 거절되면(펜스 불일치 = 다른 워커가 reclaim) 완료 판정을 건드리지 않는다', async () => {
    const f = build({ row: row(RecipientStatus.PENDING), settleOk: false, hasUnsettled: false });
    await f.service.handle(data);
    expect(f.transitions).toHaveLength(0);
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
    expect(f.settled[0].patch).toMatchObject({ status: RecipientStatus.SENT, messageId: 'm_77' });
  });

  it('이력이 없고 알림이 살아 있으면 그제야 실제로 보낸다 (같은 펜스로 기록)', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN), result: { kind: 'sent', messageId: 'm_2' } });
    f.client.lookupResult = null;
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'sent' });
    expect(f.client.sendCalls).toBe(1);
    expect(f.settled[0].fence).toBe(f.claimedFences[0]);
  });

  it('이력이 없고 알림이 취소됐으면 보내지 않고 CANCELLED 로 기록한다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN), alarmStatus: AlarmStatus.CANCELLED });
    f.client.lookupResult = null;
    await expect(f.service.handle(data)).resolves.toEqual({ action: 'done', reason: 'reconciled_cancelled' });
    expect(f.client.sendCalls).toBe(0);
    expect(f.settled[0].patch).toEqual({ status: RecipientStatus.CANCELLED });
  });

  it('조회 자체가 실패하면 UNKNOWN 을 유지하고 다시 예약한다', async () => {
    const f = build({ row: row(RecipientStatus.UNKNOWN) });
    f.client.lookupError = new Error('boom');
    await expect(f.service.handle(data)).resolves.toMatchObject({ action: 'retry', reason: 'reconcile_failed' });
    expect(f.settled[0].patch).toEqual({ status: RecipientStatus.UNKNOWN });
  });

  it('lease 가 살아 있는 PROCESSING(다른 워커 처리 중) 은 건드리지 않고 lease 만큼 뒤에 다시 본다', async () => {
    const f = build({ row: row(RecipientStatus.PROCESSING), reclaimOk: false });
    await expect(f.service.handle(data)).resolves.toMatchObject({
      action: 'retry',
      reason: 'processing_elsewhere',
      delayMs: LEASE_SEC * 1000,
    });
    expect(f.client.sendCalls).toBe(0);
  });
});
