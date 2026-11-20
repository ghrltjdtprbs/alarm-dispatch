import { ConfigService } from '@nestjs/config';

import { MockSendClient } from './mock-send-client';

// fetch 를 스텁해 HTTP 응답 → SendResult 매핑만 검증한다
describe('MockSendClient 응답 매핑', () => {
  const config = {
    get: () => ({ baseUrl: 'http://mock:4000/', rateLimitPerSec: 45, requestTimeoutMs: 1000 }),
  } as unknown as ConfigService<never, true>;
  const request = { alarmId: 'a', recipientId: 'u_1', title: 't', body: 'b', clientRef: 'a:u_1' };
  const originalFetch = global.fetch;

  const stub = (impl: () => Promise<Response>): void => {
    global.fetch = jest.fn(impl);
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('202 는 sent + messageId', async () => {
    stub(() => Promise.resolve(json(202, { messageId: 'm_1' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({ kind: 'sent', messageId: 'm_1' });
  });

  it('400 은 permanent + 응답 code', async () => {
    stub(() => Promise.resolve(json(400, { code: 'RECIPIENT_BLOCKED' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({
      kind: 'permanent',
      code: 'RECIPIENT_BLOCKED',
    });
  });

  it('429 는 Retry-After(초) 를 ms 로 바꾸고, 헤더가 없거나 0 이면 기본 1초', async () => {
    stub(() => Promise.resolve(json(429, { code: 'RATE_LIMITED' }, { 'retry-after': '3' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterMs: 3000,
    });
    stub(() => Promise.resolve(json(429, { code: 'RATE_LIMITED' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterMs: 1000,
    });
    stub(() => Promise.resolve(json(429, { code: 'RATE_LIMITED' }, { 'retry-after': '0' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterMs: 1000,
    });
  });

  it('500/503 은 temporary, 본문이 JSON 이 아니면 HTTP_<status>', async () => {
    stub(() => Promise.resolve(json(503, { code: 'SERVICE_UNAVAILABLE' })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({
      kind: 'temporary',
      code: 'SERVICE_UNAVAILABLE',
    });
    stub(() => Promise.resolve(new Response('upstream down', { status: 500 })));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({ kind: 'temporary', code: 'HTTP_500' });
  });

  it('TimeoutError 는 timeout, 그 외 fetch 실패는 network + cause.code', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    stub(() => Promise.reject(timeout));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({ kind: 'timeout' });
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    stub(() => Promise.reject(refused));
    await expect(new MockSendClient(config).send(request)).resolves.toEqual({ kind: 'network', code: 'ECONNREFUSED' });
  });

  it('clientRef 조회는 첫 messageId 를, 없으면 null 을 돌려주고 URL 에 clientRef 를 인코딩한다', async () => {
    const calls: string[] = [];
    stub(() => Promise.resolve(json(200, { messages: [{ messageId: 'm_5' }] })));
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve(json(200, { messages: [{ messageId: 'm_5' }] }));
    });
    await expect(new MockSendClient(config).findMessageIdByClientRef('a:u_1')).resolves.toBe('m_5');
    expect(calls[0]).toBe('http://mock:4000/v1/messages?clientRef=a%3Au_1');
    stub(() => Promise.resolve(json(200, { messages: [] })));
    await expect(new MockSendClient(config).findMessageIdByClientRef('a:u_1')).resolves.toBeNull();
  });

  it('사용자 목록은 id 와 nextCursor 만 추려 돌려준다', async () => {
    stub(() => Promise.resolve(json(200, { users: [{ id: 'u_1', name: 'x' }], nextCursor: 'MTAx' })));
    await expect(new MockSendClient(config).listUsers(null, 1000)).resolves.toEqual({
      ids: ['u_1'],
      nextCursor: 'MTAx',
    });
  });
});
