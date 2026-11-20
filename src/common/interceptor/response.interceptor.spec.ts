import { ExecutionContext, HttpCode } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ResponseDTO } from '../dto/response.dto';
import { ResponseInterceptor } from './response.interceptor';

// 인터셉터가 만드는 code 가 Nest 가 실제로 내려줄 HTTP 상태와 일치하는지 검증한다
class Dummy {
  plain(this: void): string {
    return 'x';
  }

  @HttpCode(202)
  accepted(this: void): string {
    return 'x';
  }
}

// getHandler 는 데코레이터 메타데이터를 읽을 함수 참조만 넘기면 되므로 this 바인딩은 필요 없다
function contextOf(method: string, handler: () => unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor<unknown>();
  const run = (ctx: ExecutionContext, body: unknown) =>
    lastValueFrom(interceptor.intercept(ctx, { handle: () => of(body) }));

  it('GET 은 200 으로 감싼다', async () => {
    const res = await run(contextOf('GET', Dummy.prototype.plain), { a: 1 });
    expect(res).toMatchObject({ code: 200, message: null, data: { a: 1 } });
  });

  it('POST 는 @HttpCode 가 없으면 Nest 기본값 201 로 감싼다', async () => {
    const res = await run(contextOf('POST', Dummy.prototype.plain), { id: 'u' });
    expect(res.code).toBe(201);
  });

  it('@HttpCode 가 있으면 그 값을 쓴다', async () => {
    const res = await run(contextOf('POST', Dummy.prototype.accepted), null);
    expect(res.code).toBe(202);
    expect(res.data).toBeNull();
  });

  it('이미 ResponseDTO 면 그대로 통과시킨다', async () => {
    const dto = ResponseDTO.ok({ keep: true }, 200, '메시지');
    const res = await run(contextOf('GET', Dummy.prototype.plain), dto);
    expect(res).toBe(dto);
  });

  it('반환값이 undefined 면 data 는 null 이다', async () => {
    const res = await run(contextOf('DELETE', Dummy.prototype.plain), undefined);
    expect(res.data).toBeNull();
  });
});
