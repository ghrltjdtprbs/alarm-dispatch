import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../application.exception';
import { ErrorCode } from '../error-code';

// HTTP UNAUTHORIZED 용 표준 예외. ErrorCode 의 status 가 맞지 않으면 개발 실수이므로 생성 시점에 막는다
export class UnauthorizedException extends ApplicationException {
  constructor(errorCode: ErrorCode, messageOverride?: string) {
    if (errorCode.status !== HttpStatus.UNAUTHORIZED) {
      throw new Error(
        `UnauthorizedException 은 status ${HttpStatus.UNAUTHORIZED} 인 ErrorCode 만 받는다: ${errorCode.code}(${errorCode.status})`,
      );
    }
    super(errorCode, messageOverride);
  }
}
