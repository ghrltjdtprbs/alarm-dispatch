import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration } from '../../common/config/configuration';
import { SendClient, SendMessageRequest, SendResult, UserPage } from './send-client';

interface ErrorBody {
  code?: string;
  message?: string;
}

// 과제 제공 mock 서버 HTTP 클라이언트 (docs/mock-api.md). Node 22 내장 fetch + AbortSignal.timeout
@Injectable()
export class MockSendClient implements SendClient {
  private readonly logger = new Logger(MockSendClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<Configuration, true>) {
    const mockApi = config.get('mockApi', { infer: true });
    this.baseUrl = mockApi.baseUrl.replace(/\/$/, '');
    this.timeoutMs = mockApi.requestTimeoutMs;
  }

  async send(request: SendMessageRequest): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // AbortSignal.timeout 은 TimeoutError 로 reject 된다. 그 외는 DNS/연결 오류
      if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'timeout' };
      return { kind: 'network', code: error instanceof Error ? error.name : 'UNKNOWN' };
    }

    if (res.status === 202 || res.status === 200) {
      const body = (await res.json()) as { messageId: string };
      return { kind: 'sent', messageId: body.messageId };
    }
    const code = await this.readErrorCode(res);
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after') ?? '1');
      return { kind: 'rate_limited', retryAfterMs: (Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000 };
    }
    if (res.status >= 500) return { kind: 'temporary', code };
    if (res.status >= 400) return { kind: 'permanent', code };
    this.logger.warn(`[mock 예상 밖 응답] status=${res.status} code=${code}`);
    return { kind: 'temporary', code };
  }

  async findMessageIdByClientRef(clientRef: string): Promise<string | null> {
    const url = `${this.baseUrl}/v1/messages?clientRef=${encodeURIComponent(clientRef)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`clientRef 조회 실패 status=${res.status}`);
    const body = (await res.json()) as { messages: { messageId: string }[] };
    return body.messages.length > 0 ? body.messages[0].messageId : null;
  }

  async listUsers(cursor: string | null, limit: number): Promise<UserPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${this.baseUrl}/v1/users?${params.toString()}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`사용자 목록 조회 실패 status=${res.status}`);
    const body = (await res.json()) as { users: { id: string }[]; nextCursor: string | null };
    return { ids: body.users.map((u) => u.id), nextCursor: body.nextCursor };
  }

  private async readErrorCode(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as ErrorBody;
      return body.code ?? `HTTP_${res.status}`;
    } catch {
      return `HTTP_${res.status}`;
    }
  }
}
