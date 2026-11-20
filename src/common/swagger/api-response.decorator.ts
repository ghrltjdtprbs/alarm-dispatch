import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { PagedResponse } from '../dto/paged-response.dto';
import { ResponseDTO } from '../dto/response.dto';

interface Options {
  status?: number;
  description?: string;
  isArray?: boolean;
}

// 성공 응답 스키마를 ResponseDTO<T> 래퍼 포함으로 문서화한다. 모든 엔드포인트에 필수 (docs/conventions/swagger.md)
export function ApiOkResponseDTO<T>(model: Type<T>, options: Options = {}) {
  const { status = 200, description = '성공', isArray = false } = options;
  const item = { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(ResponseDTO, model),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseDTO) },
          { properties: { data: isArray ? { type: 'array', items: item } : item } },
        ],
      },
    }),
  );
}

// 목록 조회용: ResponseDTO<PagedResponse<T>>
export function ApiPagedResponseDTO<T>(model: Type<T>, description = '성공') {
  return applyDecorators(
    ApiExtraModels(ResponseDTO, PagedResponse, model),
    ApiResponse({
      status: 200,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseDTO) },
          {
            properties: {
              data: {
                allOf: [
                  { $ref: getSchemaPath(PagedResponse) },
                  { properties: { items: { type: 'array', items: { $ref: getSchemaPath(model) } } } },
                ],
              },
            },
          },
        ],
      },
    }),
  );
}

// 데이터 없는 성공 응답 (예: 취소/삭제). data 는 null
export function ApiEmptyResponseDTO(status = 200, description = '성공') {
  return applyDecorators(
    ApiExtraModels(ResponseDTO),
    ApiResponse({ status, description, schema: { $ref: getSchemaPath(ResponseDTO) } }),
  );
}

/**
 * 에러 응답 문서화. 같은 status 에 @ApiResponse 를 두 번 붙이면 뒤가 앞을 덮으므로,
 * 한 status 에서 날 수 있는 에러 코드는 배열로 한 번에 넘긴다 (description 과 error.code enum 에 반영).
 */
export function ApiErrorResponseDTO(status: number, description: string, errorCodes: string | string[]) {
  const codes = Array.isArray(errorCodes) ? errorCodes : [errorCodes];
  return applyDecorators(
    ApiExtraModels(ResponseDTO),
    ApiResponse({
      status,
      description: `${description} (${codes.join(' / ')})`,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseDTO) },
          {
            properties: {
              code: { example: status },
              error: { properties: { code: { enum: codes, example: codes[0] } } },
            },
          },
        ],
      },
    }),
  );
}
