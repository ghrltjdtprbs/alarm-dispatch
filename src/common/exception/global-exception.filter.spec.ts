import { ArgumentsHost, BadRequestException, NotFoundException as NestNotFound } from '@nestjs/common';

import { ErrorCode } from './error-code';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ConflictException, NotFoundException } from './predefined';

// 필터가 예외를 일관된 ResponseDTO 로 바꾸는지 검증한다. 로그는 검증 대상이 아니므로 Logger 는 무시한다
describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();
  let status: number;
  let body: Record<string, unknown>;

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', originalUrl: '/api/v1/alarms/x' }),
      getResponse: () => ({
        status: (s: number) => {
          status = s;
          return { json: (b: Record<string, unknown>) => (body = b) };
        },
      }),
    }),
  } as unknown as ArgumentsHost;

  beforeAll(() => {
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('predefined 예외는 ErrorCode 의 status 와 code 로 응답한다', () => {
    filter.catch(new NotFoundException(ErrorCode.RESOURCE_NOT_FOUND), host);
    expect(status).toBe(404);
    expect(body).toMatchObject({
      code: 404,
      data: null,
      message: ErrorCode.RESOURCE_NOT_FOUND.message,
      error: { code: 'RESOURCE_NOT_FOUND' },
    });
  });

  it('메시지를 덮어쓴 예외는 덮어쓴 메시지를 노출한다', () => {
    filter.catch(new ConflictException(ErrorCode.RESOURCE_CONFLICT, '이미 발송이 시작된 알림입니다.'), host);
    expect(body.message).toBe('이미 발송이 시작된 알림입니다.');
  });

  it('ValidationPipe 의 400 은 VALIDATION_FAILED 와 필드별 사유를 담는다', () => {
    filter.catch(new BadRequestException(['title must be a string', 'body should not be empty']), host);
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: ['title must be a string', 'body should not be empty'] },
    });
  });

  it('라우트 없음(Nest NotFoundException) 은 RESOURCE_NOT_FOUND 로 응답한다', () => {
    filter.catch(new NestNotFound(), host);
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('알 수 없는 예외는 내부 정보 없이 500 으로 응답한다', () => {
    filter.catch(new TypeError('secret internal detail'), host);
    expect(status).toBe(500);
    expect(body.message).toBe(ErrorCode.INTERNAL_SERVER_ERROR.message);
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });

  it('status 가 맞지 않는 ErrorCode 로 predefined 예외를 만들면 즉시 실패한다', () => {
    expect(() => new NotFoundException(ErrorCode.RESOURCE_CONFLICT)).toThrow(/status 404/);
  });
});
