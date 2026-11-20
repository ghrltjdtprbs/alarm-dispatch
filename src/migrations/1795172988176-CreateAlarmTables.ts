import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAlarmTables1795172988176 implements MigrationInterface {
  name = 'CreateAlarmTables1795172988176';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // uuid_generate_v4() 는 uuid-ossp 확장이 필요하다. 새 DB 에서도 마이그레이션만으로 기동되도록 여기서 보장
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "alarms" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(10) NOT NULL, "title" character varying(200) NOT NULL, "body" text NOT NULL, "status" character varying(20) NOT NULL, CONSTRAINT "PK_b776da486fb19d38b4f7777a6da" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_alarms_status_created_at" ON "alarms" ("status", "created_at") `);
    await queryRunner.query(
      `CREATE TABLE "alarm_recipients" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" BIGSERIAL NOT NULL, "alarm_id" uuid NOT NULL, "recipient_id" character varying(32) NOT NULL, "status" character varying(20) NOT NULL, "attempt_count" integer NOT NULL DEFAULT '0', "lease_until" TIMESTAMP WITH TIME ZONE, "message_id" character varying(64), "last_error" character varying(64), "sent_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_alarm_recipients_alarm_recipient" UNIQUE ("alarm_id", "recipient_id"), CONSTRAINT "PK_ab6a51d8a9e21a87dafc02bc03d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_alarm_recipients_alarm_status" ON "alarm_recipients" ("alarm_id", "status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "alarm_recipients" ADD CONSTRAINT "FK_355c34f3025a60d7304d4e08b2e" FOREIGN KEY ("alarm_id") REFERENCES "alarms"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarm_recipients" DROP CONSTRAINT "FK_355c34f3025a60d7304d4e08b2e"`);
    await queryRunner.query(`DROP INDEX "public"."idx_alarm_recipients_alarm_status"`);
    await queryRunner.query(`DROP TABLE "alarm_recipients"`);
    await queryRunner.query(`DROP INDEX "public"."idx_alarms_status_created_at"`);
    await queryRunner.query(`DROP TABLE "alarms"`);
  }
}
