import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptimisticLockVersionMismatchError, QueryFailedError } from 'typeorm';
import { ResponseDTO } from '../dto/response.dto';
import { ApplicationException, QuietApplicationException } from './application.exception';
import { ErrorCode } from './error-code';

// PostgreSQL unique_violation
const PG_UNIQUE_VIOLATION = '23505';

/**
 * 전역 예외 → ResponseDTO 변환. 로깅은 여기서 한 번만 한다 ("Log or Throw", docs/conventions/exception.md).
 * 4xx 는 WARN, 5xx 는 ERROR + 스택.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const body = this.toResponse(exception);
    this.log(exception, body, req);
    res.status(body.code).json(body);
  }

  private toResponse(exception: unknown): ResponseDTO<null> {
    // 1. 비즈니스 예외 — ErrorCode 그대로 매핑
    if (exception instanceof ApplicationException) {
      return ResponseDTO.error(exception.errorCode, exception.message);
    }

    // 2. Nest 내장 HttpException — ValidationPipe(400), 라우트 없음(404) 등
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    // 3. TypeORM — 유니크 제약 위반은 409, 낙관적 락 충돌은 409
    if (
      exception instanceof QueryFailedError &&
      (exception as { driverError?: { code?: string } }).driverError?.code === PG_UNIQUE_VIOLATION
    ) {
      return ResponseDTO.error(ErrorCode.RESOURCE_CONFLICT);
    }
    if (exception instanceof OptimisticLockVersionMismatchError) {
      return ResponseDTO.error(ErrorCode.CONCURRENT_MODIFICATION);
    }

    // 4. 그 외 — 내부 정보 노출 금지, 고정 메시지
    return ResponseDTO.error(ErrorCode.INTERNAL_SERVER_ERROR);
  }

  private fromHttpException(exception: HttpException): ResponseDTO<null> {
    const status = exception.getStatus() as HttpStatus;
    const raw = exception.getResponse();
    // ValidationPipe 는 { message: string[] } 형태로 필드별 사유를 담는다
    const details =
      typeof raw === 'object' && Array.isArray((raw as { message?: unknown }).message)
        ? (raw as { message: string[] }).message
        : undefined;

    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ResponseDTO.error(ErrorCode.VALIDATION_FAILED, undefined, details);
      case HttpStatus.UNAUTHORIZED:
        return ResponseDTO.error(ErrorCode.UNAUTHORIZED);
      case HttpStatus.FORBIDDEN:
        return ResponseDTO.error(ErrorCode.FORBIDDEN);
      case HttpStatus.NOT_FOUND:
        return ResponseDTO.error(ErrorCode.RESOURCE_NOT_FOUND);
      case HttpStatus.CONFLICT:
        return ResponseDTO.error(ErrorCode.RESOURCE_CONFLICT);
      default:
        return status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? ResponseDTO.error(ErrorCode.INTERNAL_SERVER_ERROR)
          : ResponseDTO.error(ErrorCode.INVALID_REQUEST, exception.message);
    }
  }

  private log(exception: unknown, body: ResponseDTO<null>, req: Request): void {
    const where = `${req.method} ${req.originalUrl}`;
    if (body.code >= 500) {
      this.logger.error(
        `[요청 실패] ${where} code=${body.error?.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }
    if (exception instanceof QuietApplicationException) {
      this.logger.warn(`[요청 거절] ${where} code=${body.error?.code}`);
      return;
    }
    this.logger.warn(`[요청 거절] ${where} code=${body.error?.code} message=${body.message}`);
  }
}
