import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';
import { ResponseDTO } from '../dto/response.dto';

/**
 * 컨트롤러 반환값을 ResponseDTO 로 감싼다. 이미 ResponseDTO 면 그대로 통과시킨다.
 * code 는 Nest 가 실제로 내려줄 HTTP 상태와 같아야 하는데, @HttpCode 는 인터셉터 이후에 적용되므로
 * res.statusCode 를 읽지 않고 핸들러 메타데이터(@HttpCode) 와 Nest 기본 규칙(POST 201, 그 외 200) 으로 계산한다.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ResponseDTO<T>> {
  private readonly reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ResponseDTO<T>> {
    const status = this.resolveStatus(context);
    return next.handle().pipe(
      map((body) => {
        if (ResponseDTO.isResponseDTO(body)) {
          return body as ResponseDTO<T>;
        }
        return ResponseDTO.ok<T>(body ?? null, status);
      }),
    );
  }

  private resolveStatus(context: ExecutionContext): number {
    const explicit = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (explicit !== undefined) {
      return explicit;
    }
    const method = context.switchToHttp().getRequest<Request>().method;
    return method === RequestMethod[RequestMethod.POST] ? HttpStatus.CREATED : HttpStatus.OK;
  }
}
