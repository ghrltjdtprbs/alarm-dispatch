import { ApiProperty } from '@nestjs/swagger';

import { ErrorCode } from '../exception/error-code';

export class ErrorBody {
  @ApiProperty({ description: '에러 코드 (ErrorCode.code)', example: 'ALARM_NOT_FOUND', required: true })
  code: string;

  @ApiProperty({
    description: '상세 사유 목록 (검증 실패 시 필드별 메시지). 없으면 생략',
    example: ['title must be longer than or equal to 1 characters'],
    required: false,
    type: [String],
  })
  details?: string[];

  constructor(code: string, details?: string[]) {
    this.code = code;
    this.details = details;
  }
}

/**
 * 모든 REST 응답을 감싸는 공통 래퍼. ResponseInterceptor 가 컨트롤러 반환값을 자동으로 감싸므로
 * 컨트롤러는 data 만 반환하면 된다. 에러 응답은 GlobalExceptionFilter 가 만든다 (직접 생성 금지).
 */
export class ResponseDTO<T> {
  @ApiProperty({ description: 'HTTP 상태 코드', example: 200, required: true })
  code: number;

  @ApiProperty({
    description: '응답 메시지. 성공 시 null, 에러 시 사용자 노출 메시지',
    example: null,
    required: false,
    nullable: true,
  })
  message: string | null;

  @ApiProperty({ description: '응답 데이터. 에러 시 null', example: {}, required: false, nullable: true })
  data: T | null;

  @ApiProperty({
    description: '에러 정보. 성공 시 생략',
    type: ErrorBody,
    example: { code: 'ALARM_NOT_FOUND' },
    required: false,
  })
  error?: ErrorBody;

  private constructor(code: number, message: string | null, data: T | null, error?: ErrorBody) {
    this.code = code;
    this.message = message;
    this.data = data;
    this.error = error;
  }

  static isResponseDTO(value: unknown): value is ResponseDTO<unknown> {
    return value instanceof ResponseDTO;
  }

  // 성공 응답. HTTP 상태는 실제 응답 상태(200/201 등)를 그대로 넣는다
  static ok<T>(data: T | null, status = 200, message: string | null = null): ResponseDTO<T> {
    return new ResponseDTO<T>(status, message, data);
  }

  // 에러 응답 — ErrorCode 기반. GlobalExceptionFilter 전용
  static error(errorCode: ErrorCode, message?: string, details?: string[]): ResponseDTO<null> {
    return new ResponseDTO<null>(
      errorCode.status,
      message ?? errorCode.message,
      null,
      new ErrorBody(errorCode.code, details),
    );
  }
}
