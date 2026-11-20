import { ErrorCode } from './error-code';

/**
 * 모든 비즈니스 예외의 부모. ErrorCode 를 보유하며 GlobalExceptionFilter 가 status/message 로 변환한다.
 * 도메인 코드에서는 predefined/* 예외를 우선 쓰고, 추가 정보를 들고 다녀야 할 때만 직접 상속한다 (docs/conventions/exception.md)
 */
export class ApplicationException extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    // 사용자 노출 메시지를 ErrorCode 기본값 대신 바꿔야 할 때만 지정 (민감정보 금지)
    messageOverride?: string,
  ) {
    super(messageOverride ?? errorCode.message);
    this.name = new.target.name;
  }

  get status(): number {
    return this.errorCode.status;
  }
}

/**
 * 스택 트레이스가 디버깅에 무의미하고 매우 자주 발생하는 검증 실패용 경량 예외.
 * 필터가 WARN 한 줄만 남긴다.
 */
export class QuietApplicationException extends ApplicationException {
  constructor(errorCode: ErrorCode, messageOverride?: string) {
    super(errorCode, messageOverride);
    this.stack = undefined;
  }
}
