import 'dotenv/config';
import { DataSource } from 'typeorm';

// TypeORM CLI(migration:generate/run) 전용 DataSource. 앱 런타임은 typeorm.config.ts 를 쓴다
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
});
