import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

// 생성/수정 시각 자동 추적. 도메인 엔티티는 createdAt/updatedAt 을 직접 선언하지 말고 상속한다 (docs/conventions/entity.md)
export abstract class BaseEntity {
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
