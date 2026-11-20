import * as request from 'supertest';
import { ResponseDTO } from '../src/common/dto/response.dto';
import { createTestApp, TestContext } from './support/integration-test.support';

// e2e 지원(createTestApp)과 공통 응답/에러 형식이 실제 HTTP 경로에서 동작하는지 검증한다
describe('공통 응답 형식 (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('성공 응답은 ResponseDTO 형식으로 감싸진다', async () => {
    const res = await request(ctx.server).get('/health').expect(200);
    expect(res.body).toEqual({ code: 200, message: null, data: { status: 'ok' } });
  });

  it('없는 경로는 404 와 RESOURCE_NOT_FOUND 에러 형식으로 응답한다', async () => {
    const res = await request(ctx.server).get('/api/v1/nope').expect(404);
    const body = res.body as ResponseDTO<null>;
    expect(body).toMatchObject({ code: 404, data: null, error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(typeof body.message).toBe('string');
  });

  it('e2e 는 .env.test 의 테스트 DB 에 연결된다', () => {
    expect((ctx.dataSource.options as { database?: string }).database).toBe('alarm_test');
  });

  it('truncateAll 은 등록된 엔티티가 없어도 실패하지 않는다', async () => {
    await expect(ctx.truncateAll()).resolves.toBeUndefined();
  });
});
