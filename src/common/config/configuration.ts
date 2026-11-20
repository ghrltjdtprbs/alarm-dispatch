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
  SEND_RATE_LIMIT_PER_SEC: Joi.number().integer().min(1).default(50),
  SEND_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),
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

export interface Configuration {
  app: AppConfig;
  db: DbConfig;
  redis: RedisConfig;
  mockApi: MockApiConfig;
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
});
