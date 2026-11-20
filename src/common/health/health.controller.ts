import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiOkResponseDTO } from '../swagger/api-response.decorator';
import { HealthResponse } from './health.response';

/** 컨테이너/로드밸런서 헬스체크용. 버전 prefix 예외 (docs/conventions/api.md §1). */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '헬스체크', description: 'API 프로세스가 요청을 받을 수 있는지 확인한다.' })
  @ApiOkResponseDTO(HealthResponse)
  check(): HealthResponse {
    return new HealthResponse();
  }
}
