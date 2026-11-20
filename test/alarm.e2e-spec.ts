import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as request from 'supertest';
import { PagedResponse } from '../src/common/dto/paged-response.dto';
import { ResponseDTO } from '../src/common/dto/response.dto';
import { AlarmStatus } from '../src/modules/alarm/alarm-status.enum';
import { AlarmType } from '../src/modules/alarm/alarm-type.enum';
import { AlarmDetailResponse, AlarmResponse } from '../src/modules/alarm/dto/alarm.response';
import { AlarmRecipientResponse } from '../src/modules/alarm/dto/alarm-recipient.response';
import { DISPATCH_QUEUE, prepareJobId } from '../src/modules/dispatch/dispatch-job';
import { runConcurrently } from './support/concurrency.support';
import { createTestApp, TestContext } from './support/integration-test.support';

const BASE = '/api/v1/alarms';

describe('알림 API (e2e)', () => {
  let ctx: TestContext;
  let queue: Queue;

  beforeAll(async () => {
    ctx = await createTestApp();
    queue = ctx.app.get<Queue>(getQueueToken(DISPATCH_QUEUE));
  });

  beforeEach(async () => {
    await ctx.truncateAll();
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await ctx.close();
  });

  const createAlarm = async (body: Record<string, unknown> = {}): Promise<AlarmResponse> => {
    const res = await request(ctx.server)
      .post(BASE)
      .send({ title: '점검 안내', body: '내일 새벽 점검', ...body })
      .expect(201);
    return (res.body as ResponseDTO<AlarmResponse>).data as AlarmResponse;
  };

  describe('생성', () => {
    it('대량 알림은 CREATED 상태로 생성되고 201 을 돌려준다', async () => {
      const alarm = await createAlarm();
      expect(alarm).toMatchObject({ type: AlarmType.BULK, status: AlarmStatus.CREATED, title: '점검 안내' });
      expect(alarm.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('긴급 알림은 수신자를 생성 시 적재한다 (중복 id 는 하나로)', async () => {
      const alarm = await createAlarm({ type: AlarmType.URGENT, recipientIds: ['u_000001', 'u_000002', 'u_000001'] });
      const res = await request(ctx.server).get(`${BASE}/${alarm.id}`).expect(200);
      const detail = (res.body as ResponseDTO<AlarmDetailResponse>).data as AlarmDetailResponse;
      expect(detail.progress).toMatchObject({ total: 2, pending: 2 });
    });

    it('긴급 알림에 수신자가 없으면 400 ALARM_RECIPIENTS_INVALID', async () => {
      const res = await request(ctx.server).post(BASE).send({ type: 'URGENT', title: 't', body: 'b' }).expect(400);
      expect((res.body as ResponseDTO<null>).error?.code).toBe('ALARM_RECIPIENTS_INVALID');
    });

    it('대량 알림에 수신자를 지정하면 400', async () => {
      const res = await request(ctx.server)
        .post(BASE)
        .send({ title: 't', body: 'b', recipientIds: ['u_000001'] })
        .expect(400);
      expect((res.body as ResponseDTO<null>).error?.code).toBe('ALARM_RECIPIENTS_INVALID');
    });

    it('제목이 비거나 모르는 필드가 있으면 400 VALIDATION_FAILED 와 상세 사유', async () => {
      const res = await request(ctx.server).post(BASE).send({ title: '', body: 'b', foo: 1 }).expect(400);
      const body = res.body as ResponseDTO<null>;
      expect(body.error?.code).toBe('VALIDATION_FAILED');
      expect(body.error?.details?.length).toBeGreaterThan(0);
    });
  });

  describe('조회', () => {
    it('목록은 생성일 역순 페이지로 돌려주고 상태 필터가 동작한다', async () => {
      const first = await createAlarm({ title: '첫째' });
      const second = await createAlarm({ title: '둘째' });
      await request(ctx.server).post(`${BASE}/${second.id}/cancel`).expect(200);

      const all = await request(ctx.server).get(BASE).query({ page: 0, size: 10 }).expect(200);
      const page = (all.body as ResponseDTO<PagedResponse<AlarmResponse>>).data as PagedResponse<AlarmResponse>;
      expect(page.totalElements).toBe(2);
      expect(page.items.map((a) => a.id)).toEqual([second.id, first.id]);

      const cancelled = await request(ctx.server).get(BASE).query({ status: 'CANCELLED' }).expect(200);
      const filtered = (cancelled.body as ResponseDTO<PagedResponse<AlarmResponse>>)
        .data as PagedResponse<AlarmResponse>;
      expect(filtered.items.map((a) => a.id)).toEqual([second.id]);
    });

    it('없는 알림은 404 ALARM_NOT_FOUND, uuid 형식이 아니면 400', async () => {
      const res = await request(ctx.server).get(`${BASE}/3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70`).expect(404);
      expect((res.body as ResponseDTO<null>).error?.code).toBe('ALARM_NOT_FOUND');
      await request(ctx.server).get(`${BASE}/not-uuid`).expect(400);
    });

    it('수신자 목록은 상태 필터와 페이징으로 조회된다', async () => {
      const alarm = await createAlarm({ type: AlarmType.URGENT, recipientIds: ['u_000001', 'u_000002', 'u_000003'] });
      const res = await request(ctx.server)
        .get(`${BASE}/${alarm.id}/recipients`)
        .query({ status: 'PENDING', size: 2 })
        .expect(200);
      const page = (res.body as ResponseDTO<PagedResponse<AlarmRecipientResponse>>)
        .data as PagedResponse<AlarmRecipientResponse>;
      expect(page.totalElements).toBe(3);
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ recipientId: 'u_000001', status: 'PENDING', messageId: null });
    });
  });

  describe('발송 시작', () => {
    it('CREATED 알림은 202 와 PREPARING 을 돌려주고 prepare 잡이 큐에 들어간다', async () => {
      const alarm = await createAlarm();
      const res = await request(ctx.server).post(`${BASE}/${alarm.id}/send`).expect(202);
      expect((res.body as ResponseDTO<AlarmResponse>).data?.status).toBe(AlarmStatus.PREPARING);

      const job = await queue.getJob(prepareJobId(alarm.id));
      expect(job?.data).toEqual({ alarmId: alarm.id, type: AlarmType.BULK });
    });

    it('동시에 N번 시작해도 1건만 202 이고 나머지는 409, 잡도 1개만 들어간다', async () => {
      const alarm = await createAlarm();
      const statuses: number[] = [];
      await runConcurrently(10, async () => {
        const res = await request(ctx.server).post(`${BASE}/${alarm.id}/send`);
        statuses.push(res.status);
      });
      expect(statuses.filter((s) => s === 202)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9);
      expect(await queue.getJobCountByTypes('waiting', 'prioritized', 'active', 'delayed')).toBe(1);
    });

    it('이미 시작한 알림을 다시 시작하면 409 ALARM_INVALID_STATUS', async () => {
      const alarm = await createAlarm();
      await request(ctx.server).post(`${BASE}/${alarm.id}/send`).expect(202);
      const res = await request(ctx.server).post(`${BASE}/${alarm.id}/send`).expect(409);
      expect((res.body as ResponseDTO<null>).error?.code).toBe('ALARM_INVALID_STATUS');
    });
  });

  describe('취소', () => {
    it('발송 시작 전 취소하면 CANCELLED 가 되고 대기 수신자는 전부 CANCELLED', async () => {
      const alarm = await createAlarm({ type: AlarmType.URGENT, recipientIds: ['u_000001', 'u_000002'] });
      const res = await request(ctx.server).post(`${BASE}/${alarm.id}/cancel`).expect(200);
      expect((res.body as ResponseDTO<AlarmResponse>).data?.status).toBe(AlarmStatus.CANCELLED);

      const detail = await request(ctx.server).get(`${BASE}/${alarm.id}`).expect(200);
      expect(((detail.body as ResponseDTO<AlarmDetailResponse>).data as AlarmDetailResponse).progress).toMatchObject({
        cancelled: 2,
        pending: 0,
      });
    });

    it('취소된 알림은 다시 취소하거나 시작할 수 없다 (409)', async () => {
      const alarm = await createAlarm();
      await request(ctx.server).post(`${BASE}/${alarm.id}/cancel`).expect(200);
      await request(ctx.server).post(`${BASE}/${alarm.id}/cancel`).expect(409);
      await request(ctx.server).post(`${BASE}/${alarm.id}/send`).expect(409);
    });

    it('동시에 취소와 발송 시작이 와도 둘 중 하나만 성공한다', async () => {
      const alarm = await createAlarm();
      const results: string[] = [];
      await runConcurrently(6, async (i) => {
        const action = i % 2 === 0 ? 'send' : 'cancel';
        const res = await request(ctx.server).post(`${BASE}/${alarm.id}/${action}`);
        results.push(`${action}:${res.status}`);
      });
      const sendOk = results.filter((r) => r === 'send:202').length;
      const cancelOk = results.filter((r) => r === 'cancel:200').length;
      // 취소는 PREPARING 에서도 허용되므로 "시작 1 + 취소 1" 또는 "취소 1" 만 가능. 각각 두 번 성공하는 일은 없어야 한다
      expect(sendOk).toBeLessThanOrEqual(1);
      expect(cancelOk).toBe(1);
      expect(results.filter((r) => r.endsWith(':409'))).toHaveLength(6 - sendOk - cancelOk);
    });
  });
});
