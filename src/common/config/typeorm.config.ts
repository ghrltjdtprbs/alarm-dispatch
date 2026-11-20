import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Configuration } from './configuration';

export const typeOrmOptions = (config: ConfigService<Configuration, true>): TypeOrmModuleOptions => {
  const db = config.get('db', { infer: true });
  const app = config.get('app', { infer: true });
  const env = app.env;
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    autoLoadEntities: true,
    // 운영에서는 마이그레이션으로만 스키마를 바꾼다. synchronize 는 local 개발 편의용
    synchronize: env !== 'production' && db.synchronize,
    migrations: [__dirname + '/../../migrations/*.{ts,js}'],
    // 마이그레이션은 한 프로세스(api)만 돌린다. 워커 여러 대가 동시에 돌리면 CREATE TABLE 경합으로 기동이 실패한다
    migrationsRun: app.runMigrations,
    // 워커 동시성(25)만큼 짧은 쿼리가 몰리므로 풀을 그보다 조금 크게
    extra: { max: 30 },
    logging: env === 'local' ? ['error', 'warn'] : ['error'],
  };
};
