import { ApiProperty } from '@nestjs/swagger';

export class HealthResponse {
  @ApiProperty({ description: '서버 상태', example: 'ok', required: true })
  status: 'ok';

  constructor() {
    this.status = 'ok';
  }
}
