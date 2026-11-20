import { Alarm } from '../alarm/alarm.entity';
import { AlarmRepository } from '../alarm/alarm.repository';
import { AlarmRecipientRepository } from '../alarm/alarm-recipient.repository';
import { AlarmStatus } from '../alarm/alarm-status.enum';
import { AlarmType } from '../alarm/alarm-type.enum';
import { DispatchQueueProducer } from './dispatch-queue.producer';
import { PrepareService } from './prepare.service';
import { SendClient, UserPage } from './send-client';

const ALARM_ID = '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70';

interface Fakes {
  service: PrepareService;
  inserted: string[][];
  enqueued: { type: AlarmType; ids: string[] }[];
  transitions: [readonly AlarmStatus[], AlarmStatus][];
  cancelPendingCalls: number;
  alarmStatus: AlarmStatus;
}

function build(options: {
  type: AlarmType;
  pages?: UserPage[];
  storedRecipients?: string[];
  cancelAfterPage?: number;
  hasUnsettled?: boolean;
  failFirstPage?: boolean;
}): Fakes {
  const state: Fakes = {
    service: undefined as unknown as PrepareService,
    inserted: [],
    enqueued: [],
    transitions: [],
    cancelPendingCalls: 0,
    alarmStatus: AlarmStatus.PREPARING,
  };
  const pages = options.pages ?? [];
  let pageIndex = 0;
  let failed = false;

  const alarmRepo: Pick<AlarmRepository, 'findById' | 'transition'> = {
    findById: () => {
      const a = Alarm.create(options.type, 't', 'b');
      a.id = ALARM_ID;
      a.status = state.alarmStatus;
      return Promise.resolve(a);
    },
    transition: (_id, from, to) => {
      state.transitions.push([from, to]);
      if (from.includes(state.alarmStatus)) {
        state.alarmStatus = to;
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };
  const recipientRepo: Pick<
    AlarmRecipientRepository,
    'insertPendingIgnoreDuplicates' | 'findRecipientIds' | 'cancelPending' | 'hasUnsettled'
  > = {
    insertPendingIgnoreDuplicates: (_a, ids) => {
      state.inserted.push(ids);
      return Promise.resolve();
    },
    findRecipientIds: (_a, afterId) =>
      Promise.resolve(
        afterId ? [] : (options.storedRecipients ?? []).map((id, i) => ({ id: String(i + 1), recipientId: id })),
      ),
    cancelPending: () => {
      state.cancelPendingCalls += 1;
      return Promise.resolve(0);
    },
    hasUnsettled: () => Promise.resolve(options.hasUnsettled ?? true),
  };
  const producer: Pick<DispatchQueueProducer, 'enqueueSendBatch'> = {
    enqueueSendBatch: (_a, type, ids) => {
      state.enqueued.push({ type, ids });
      // 지정 페이지 뒤에 취소가 들어온 상황
      if (options.cancelAfterPage !== undefined && state.enqueued.length === options.cancelAfterPage) {
        state.alarmStatus = AlarmStatus.CANCELLED;
      }
      return Promise.resolve();
    },
  };
  const client: Pick<SendClient, 'listUsers'> = {
    listUsers: () => {
      if (options.failFirstPage && !failed) {
        failed = true;
        return Promise.reject(new Error('503'));
      }
      return Promise.resolve(pages[pageIndex++]);
    },
  };
  state.service = new PrepareService(
    alarmRepo as AlarmRepository,
    recipientRepo as AlarmRecipientRepository,
    producer as DispatchQueueProducer,
    client as SendClient,
  );
  return state;
}

describe('PrepareService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('대량 알림은 사용자 API 를 커서 끝까지 읽어 페이지마다 적재·투입하고 SENDING 으로 전이한다', async () => {
    const f = build({
      type: AlarmType.BULK,
      pages: [
        { ids: ['u_1', 'u_2'], nextCursor: 'c1' },
        { ids: ['u_3'], nextCursor: null },
      ],
    });
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.BULK });
    expect(f.inserted).toEqual([['u_1', 'u_2'], ['u_3']]);
    expect(f.enqueued.map((e) => e.ids)).toEqual([['u_1', 'u_2'], ['u_3']]);
    expect(f.enqueued.every((e) => e.type === AlarmType.BULK)).toBe(true);
    expect(f.alarmStatus).toBe(AlarmStatus.SENDING);
  });

  it('긴급 알림은 생성 시 적재된 수신자로 긴급 우선순위 잡만 투입한다', async () => {
    const f = build({ type: AlarmType.URGENT, storedRecipients: ['u_1', 'u_2'] });
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.URGENT });
    expect(f.inserted).toEqual([]);
    expect(f.enqueued).toEqual([{ type: AlarmType.URGENT, ids: ['u_1', 'u_2'] }]);
  });

  it('적재 중 취소되면 더 읽지 않고, 늦게 들어간 PENDING 을 마저 취소하며 SENDING 으로 가지 않는다', async () => {
    const f = build({
      type: AlarmType.BULK,
      pages: [
        { ids: ['u_1'], nextCursor: 'c1' },
        { ids: ['u_2'], nextCursor: 'c2' },
        { ids: ['u_3'], nextCursor: null },
      ],
      cancelAfterPage: 1,
    });
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.BULK });
    expect(f.inserted).toEqual([['u_1']]);
    expect(f.cancelPendingCalls).toBe(1);
    expect(f.alarmStatus).toBe(AlarmStatus.CANCELLED);
  });

  it('모든 수신자가 이미 종결됐으면(긴급이 적재 전에 끝남 등) 바로 COMPLETED 로 전이한다', async () => {
    const f = build({ type: AlarmType.URGENT, storedRecipients: ['u_1'], hasUnsettled: false });
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.URGENT });
    expect(f.alarmStatus).toBe(AlarmStatus.COMPLETED);
  });

  it('사용자 목록 조회가 일시 실패하면 백오프 후 같은 커서를 다시 읽는다', async () => {
    const f = build({ type: AlarmType.BULK, pages: [{ ids: ['u_1'], nextCursor: null }], failFirstPage: true });
    const run = f.service.handle({ alarmId: ALARM_ID, type: AlarmType.BULK });
    await jest.advanceTimersByTimeAsync(1_000);
    await run;
    expect(f.inserted).toEqual([['u_1']]);
    expect(f.alarmStatus).toBe(AlarmStatus.SENDING);
  });

  it('PREPARING 이 아닌 알림의 prepare 잡은 아무것도 하지 않는다 (재전달 안전)', async () => {
    const f = build({ type: AlarmType.BULK, pages: [{ ids: ['u_1'], nextCursor: null }] });
    f.alarmStatus = AlarmStatus.SENDING;
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.BULK });
    expect(f.inserted).toEqual([]);
    expect(f.transitions).toEqual([]);
    expect(f.cancelPendingCalls).toBe(0);
  });

  it('취소된 알림의 prepare 잡이 재전달되면 적재만 되고 남은 PENDING 을 정리한다', async () => {
    const f = build({ type: AlarmType.BULK, pages: [{ ids: ['u_1'], nextCursor: null }] });
    f.alarmStatus = AlarmStatus.CANCELLED;
    await f.service.handle({ alarmId: ALARM_ID, type: AlarmType.BULK });
    expect(f.inserted).toEqual([]);
    expect(f.cancelPendingCalls).toBe(1);
  });
});
