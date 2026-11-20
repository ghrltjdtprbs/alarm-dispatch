import { HttpStatus } from '@nestjs/common';

/**
 * 애플리케이션 전역 비즈니스 에러 코드.
 *
 * 각 예외 상황의 HTTP 상태 + 사용자 노출 메시지를 한 곳에서 정의한다. ApplicationException 과
 * predefined 예외가 이 값을 받아 throw 되고, GlobalExceptionFilter 가 status/message/code 를 응답에 그대로 매핑한다.
 *
 * 도메인 추가 시 그룹 주석 아래에 값을 추가한다. 명명: SCREAMING_SNAKE_CASE + 도메인 prefix (ALARM_NOT_FOUND).
 */
export class ErrorCode {
  private constructor(
    readonly code: string,
    readonly status: HttpStatus,
    readonly message: string,
  ) {}

  // ALARM
  static readonly ALARM_NOT_FOUND = new ErrorCode('ALARM_NOT_FOUND', HttpStatus.NOT_FOUND, '알림을 찾을 수 없습니다.');
  static readonly ALARM_INVALID_STATUS = new ErrorCode(
    'ALARM_INVALID_STATUS',
    HttpStatus.CONFLICT,
    '현재 상태에서 허용되지 않는 요청입니다.',
  );
  static readonly ALARM_RECIPIENTS_INVALID = new ErrorCode(
    'ALARM_RECIPIENTS_INVALID',
    HttpStatus.BAD_REQUEST,
    '수신자 지정이 올바르지 않습니다.',
  );

  // 공통 4xx
  static readonly INVALID_REQUEST = new ErrorCode('INVALID_REQUEST', HttpStatus.BAD_REQUEST, '잘못된 요청입니다.');
  // class-validator 검증 실패 — 필드별 사유는 error.details 에 담긴다
  static readonly VALIDATION_FAILED = new ErrorCode(
    'VALIDATION_FAILED',
    HttpStatus.BAD_REQUEST,
    '요청 값이 올바르지 않습니다.',
  );
  static readonly UNAUTHORIZED = new ErrorCode('UNAUTHORIZED', HttpStatus.UNAUTHORIZED, '인증이 필요합니다.');
  static readonly FORBIDDEN = new ErrorCode('FORBIDDEN', HttpStatus.FORBIDDEN, '해당 리소스에 접근할 권한이 없습니다.');
  static readonly RESOURCE_NOT_FOUND = new ErrorCode(
    'RESOURCE_NOT_FOUND',
    HttpStatus.NOT_FOUND,
    '요청한 리소스를 찾을 수 없습니다.',
  );
  static readonly RESOURCE_CONFLICT = new ErrorCode(
    'RESOURCE_CONFLICT',
    HttpStatus.CONFLICT,
    '리소스 상태 충돌이 발생했습니다.',
  );
  // 낙관적 락(@VersionColumn) 충돌 — 동시 수정 시 GlobalExceptionFilter 가 사용
  static readonly CONCURRENT_MODIFICATION = new ErrorCode(
    'CONCURRENT_MODIFICATION',
    HttpStatus.CONFLICT,
    '다른 요청이 먼저 처리되었습니다. 잠시 후 다시 시도해 주세요.',
  );

  // 공통 5xx
  static readonly INTERNAL_SERVER_ERROR = new ErrorCode(
    'INTERNAL_SERVER_ERROR',
    HttpStatus.INTERNAL_SERVER_ERROR,
    '서버에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  );
  static readonly EXTERNAL_API_ERROR = new ErrorCode(
    'EXTERNAL_API_ERROR',
    HttpStatus.BAD_GATEWAY,
    '외부 API 호출 중 오류가 발생했습니다.',
  );
}
