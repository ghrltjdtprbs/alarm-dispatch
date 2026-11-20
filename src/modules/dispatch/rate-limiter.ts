import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../../common/config/configuration';
import { RedisConnection } from './redis.connection';

export interface RateLimiter {
  // 토큰을 얻을 때까지 기다린다. 외부 API 호출 직전에만 부른다
  acquire(): Promise<void>;
  // 429 수신 시: 모든 워커의 HTTP 호출을 ms 동안 멈춘다 (버킷에 pause_until 기록)
  pause(ms: number): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * Redis 토큰 버킷. 워커 수와 무관하게 전역으로 초당 rate 건만 통과시킨다.
 * - Lua 로 "토큰 보충 + 차감" 을 원자적으로 수행해 워커 여러 대가 동시에 와도 초과 발급이 없다
 * - 버킷 용량을 rate 의 10% 로 작게 둔다: 어떤 1초 창에서도 통과 건수 ≤ rate + 용량 이 되어 mock 한도(50) 를 넘지 않는다
 * - 토큰이 없으면 Lua 가 다음 토큰까지의 대기 ms 를 돌려주고, 그만큼 잔 뒤 다시 시도한다
 * - 429 를 받으면 pause() 가 pause_until 을 기록하고, 모든 워커의 acquire() 가 그 시각까지 기다린다 (BullMQ 의 queue.rateLimit 은
 *   worker 에 limiter 옵션이 없으면 무시되므로 쓰지 않는다)
 */
// 버킷 용량 = rate 의 10%: 어떤 1초 창에서도 통과 건수 ≤ rate + 용량 ≤ 50 (mock 한도)
const BUCKET_CAPACITY_RATIO = 0.1;
// 버킷 상태 키 TTL. 유휴 상태가 길면 지워지고 다음 호출 때 가득 찬 상태로 다시 만들어진다
const BUCKET_TTL_MS = 60_000;

@Injectable()
export class RedisTokenBucket implements RateLimiter {
  private static readonly KEY = 'dispatch:send-bucket';
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local state = redis.call('HMGET', key, 'tokens', 'ts', 'pause_until')
    local tokens = tonumber(state[1])
    local ts = tonumber(state[2])
    local pauseUntil = tonumber(state[3]) or 0
    if pauseUntil > now then return pauseUntil - now end
    if tokens == nil then tokens = capacity; ts = now end
    local elapsed = math.max(0, now - ts)
    tokens = math.min(capacity, tokens + elapsed * rate / 1000)
    local wait = 0
    if tokens >= 1 then
      tokens = tokens - 1
    else
      wait = math.ceil((1 - tokens) * 1000 / rate)
    end
    redis.call('HSET', key, 'tokens', tokens, 'ts', now)
    redis.call('PEXPIRE', key, tonumber(ARGV[4]))
    return wait
  `;

  private readonly rate: number;
  private readonly capacity: number;

  constructor(
    private readonly redis: RedisConnection,
    config: ConfigService<Configuration, true>,
  ) {
    this.rate = config.get('mockApi', { infer: true }).rateLimitPerSec;
    this.capacity = Math.max(1, Math.floor(this.rate * BUCKET_CAPACITY_RATIO));
  }

  async pause(ms: number): Promise<void> {
    await this.redis.client.hset(RedisTokenBucket.KEY, 'pause_until', Date.now() + ms);
    await this.redis.client.pexpire(RedisTokenBucket.KEY, Math.max(BUCKET_TTL_MS, ms + 1000));
  }

  async acquire(): Promise<void> {
    for (;;) {
      const wait = Number(
        await this.redis.client.eval(
          RedisTokenBucket.SCRIPT,
          1,
          RedisTokenBucket.KEY,
          this.capacity,
          this.rate,
          Date.now(),
          BUCKET_TTL_MS,
        ),
      );
      if (wait <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
