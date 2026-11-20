import * as Joi from 'joi';

/**
 * 환경변수는 이 파일에서만 읽고 app.* 구조로 매핑한다. 다른 코드에서 process.env 직접 접근 금지 (docs/conventions/config.md).
 * 키를 추가하면 envValidationSchema 와 .env.sample 을 같이 수정한다.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('local', 'test', 'production').default('local'),
  API_PORT: Joi.number().port().default(3000),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),
  DB_SYNCHRONIZE: Joi.boolean().default(false),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),

  MOCK_API_BASE_URL: Joi.string().uri().required(),
  // mock 한도는 50/s. 초 경계 집계 차이로 429 가 나지 않도록 기본값에 10% 마진을 둔다
  SEND_RATE_LIMIT_PER_SEC: Joi.number().integer().min(1).max(50).default(45),
  SEND_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),
  // 5xx/네트워크 오류 재시도 상한 (429·타임아웃은 세지 않음)
  SEND_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  // 수신자 PROCESSING 점유 시간. 만료 후에도 PROCESSING 이면 워커 사망으로 보고 복구한다
  SEND_LEASE_SEC: Joi.number().integer().min(10).default(60),
  // 워커 프로세스당 동시 처리 잡 수. mock 응답의 5% 가 3초, 2% 가 타임아웃(5초)이라 평균 점유 ≈0.35초 → 45 rps 를 채우려면 20 이상 필요
  WORKER_CONCURRENCY: Joi.number().integer().min(1).default(25),
  // 고아 수신자(lease 만료·오래된 UNKNOWN/PENDING)·고아 알림 재투입 주기
  RECOVERY_SWEEP_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),
});

export type NodeEnv = 'local' | 'test' | 'production';

export interface AppConfig {
  env: NodeEnv;
  port: number;
}

export interface DbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  synchronize: boolean;
}

export interface RedisConfig {
  host: string;
  port: number;
}

export interface MockApiConfig {
  baseUrl: string;
  rateLimitPerSec: number;
  requestTimeoutMs: number;
}

export interface WorkerConfig {
  concurrency: number;
  maxAttempts: number;
  leaseSec: number;
  recoverySweepIntervalMs: number;
}

export interface Configuration {
  app: AppConfig;
  db: DbConfig;
  redis: RedisConfig;
  mockApi: MockApiConfig;
  worker: WorkerConfig;
}

// Joi 가 타입 변환·기본값을 끝낸 뒤 호출되므로 여기서는 매핑만 한다
export const configuration = (): Configuration => ({
  app: {
    env: process.env.NODE_ENV as NodeEnv,
    port: Number(process.env.API_PORT),
  },
  db: {
    host: process.env.DB_HOST as string,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME as string,
    password: process.env.DB_PASSWORD as string,
    database: process.env.DB_NAME as string,
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
  },
  redis: {
    host: process.env.REDIS_HOST as string,
    port: Number(process.env.REDIS_PORT),
  },
  mockApi: {
    baseUrl: process.env.MOCK_API_BASE_URL as string,
    rateLimitPerSec: Number(process.env.SEND_RATE_LIMIT_PER_SEC),
    requestTimeoutMs: Number(process.env.SEND_REQUEST_TIMEOUT_MS),
  },
  worker: {
    concurrency: Number(process.env.WORKER_CONCURRENCY),
    maxAttempts: Number(process.env.SEND_MAX_ATTEMPTS),
    leaseSec: Number(process.env.SEND_LEASE_SEC),
    recoverySweepIntervalMs: Number(process.env.RECOVERY_SWEEP_INTERVAL_MS),
  },
});
