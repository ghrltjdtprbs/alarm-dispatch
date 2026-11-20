import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Configuration } from './configuration';

export const typeOrmOptions = (config: ConfigService<Configuration, true>): TypeOrmModuleOptions => {
  const db = config.get('db', { infer: true });
  const env = config.get('app.env', { infer: true });
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
    migrationsRun: env === 'production',
    logging: env === 'local' ? ['error', 'warn'] : ['error'],
  };
};
