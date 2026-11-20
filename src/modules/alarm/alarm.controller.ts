import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { ApiVersion } from '../../common/constant/api-version';
import { PagedResponse } from '../../common/dto/paged-response.dto';
import {
  ApiErrorResponseDTO,
  ApiOkResponseDTO,
  ApiPagedResponseDTO,
} from '../../common/swagger/api-response.decorator';
import { AlarmCommandService } from './alarm-command.service';
import { AlarmQueryService } from './alarm-query.service';
import { AlarmResponse } from './dto/alarm.response';
import { AlarmDetailResponse } from './dto/alarm-detail.response';
import { AlarmListQuery } from './dto/alarm-list.query';
import { AlarmRecipientResponse } from './dto/alarm-recipient.response';
import { CreateAlarmRequest } from './dto/create-alarm.request';
import { RecipientListQuery } from './dto/recipient-list.query';

@ApiTags('Alarm')
@Controller(`${ApiVersion.V1_BASE}/alarms`)
export class AlarmController {
  constructor(
    private readonly queryService: AlarmQueryService,
    private readonly commandService: AlarmCommandService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '알림 생성',
    description: 'CREATED 상태로 생성한다. URGENT 는 recipientIds(1~100명) 필수, BULK 는 지정 불가(전체 사용자).',
  })
  @ApiOkResponseDTO(AlarmResponse, { status: 201, description: '생성됨' })
  @ApiErrorResponseDTO(400, '검증 실패 / 수신자 지정 오류', ['VALIDATION_FAILED', 'ALARM_RECIPIENTS_INVALID'])
  create(@Body() request: CreateAlarmRequest): Promise<AlarmResponse> {
    return this.commandService.create(request);
  }

  @Get()
  @ApiOperation({ summary: '알림 목록 조회', description: '생성일 역순. status/type 으로 필터할 수 있다.' })
  @ApiPagedResponseDTO(AlarmResponse)
  @ApiErrorResponseDTO(400, '쿼리 검증 실패 (page/size/status/type)', 'VALIDATION_FAILED')
  list(@Query() query: AlarmListQuery): Promise<PagedResponse<AlarmResponse>> {
    return this.queryService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '알림 단건 조회', description: '알림과 수신자 상태별 집계(progress)를 함께 돌려준다.' })
  @ApiParam({ name: 'id', description: '알림 id (uuid)', example: '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70' })
  @ApiOkResponseDTO(AlarmDetailResponse)
  @ApiErrorResponseDTO(400, 'id 가 uuid 형식이 아님', 'VALIDATION_FAILED')
  @ApiErrorResponseDTO(404, '알림 없음', 'ALARM_NOT_FOUND')
  getOne(@Param('id', new ParseUUIDPipe()) id: string): Promise<AlarmDetailResponse> {
    return this.queryService.getDetail(id);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: '알림 발송 시작',
    description:
      'CREATED 알림만 시작할 수 있다. 수신자 적재와 발송은 워커가 비동기로 처리하므로 202 를 돌려주고 상태는 PREPARING 이 된다.',
  })
  @ApiParam({ name: 'id', description: '알림 id (uuid)', example: '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70' })
  @ApiOkResponseDTO(AlarmResponse, { status: 202, description: '발송 요청 수락' })
  @ApiErrorResponseDTO(400, 'id 가 uuid 형식이 아님', 'VALIDATION_FAILED')
  @ApiErrorResponseDTO(404, '알림 없음', 'ALARM_NOT_FOUND')
  @ApiErrorResponseDTO(409, '이미 시작됐거나 종료된 알림', 'ALARM_INVALID_STATUS')
  startSend(@Param('id', new ParseUUIDPipe()) id: string): Promise<AlarmResponse> {
    return this.commandService.startSend(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '알림 발송 취소',
    description:
      'CREATED/PREPARING/SENDING 알림을 취소한다. 아직 보내지 않은 수신자는 CANCELLED, 이미 보낸 수신자는 SENT 로 남는다.',
  })
  @ApiParam({ name: 'id', description: '알림 id (uuid)', example: '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70' })
  @ApiOkResponseDTO(AlarmResponse, { description: '취소됨' })
  @ApiErrorResponseDTO(400, 'id 가 uuid 형식이 아님', 'VALIDATION_FAILED')
  @ApiErrorResponseDTO(404, '알림 없음', 'ALARM_NOT_FOUND')
  @ApiErrorResponseDTO(409, '이미 완료·취소된 알림', 'ALARM_INVALID_STATUS')
  cancel(@Param('id', new ParseUUIDPipe()) id: string): Promise<AlarmResponse> {
    return this.commandService.cancel(id);
  }

  @Get(':id/recipients')
  @ApiOperation({ summary: '수신자별 발송 상태 조회', description: '상태로 필터해 실패·미확정 수신자를 확인한다.' })
  @ApiParam({ name: 'id', description: '알림 id (uuid)', example: '3f1c2a9e-8b1d-4c2a-9f1e-2d3c4b5a6f70' })
  @ApiPagedResponseDTO(AlarmRecipientResponse)
  @ApiErrorResponseDTO(400, 'id 형식 / 쿼리 검증 실패', 'VALIDATION_FAILED')
  @ApiErrorResponseDTO(404, '알림 없음', 'ALARM_NOT_FOUND')
  listRecipients(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: RecipientListQuery,
  ): Promise<PagedResponse<AlarmRecipientResponse>> {
    return this.queryService.listRecipients(id, query);
  }
}
