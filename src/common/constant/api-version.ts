// REST 경로 prefix. Controller 는 하드코딩 대신 반드시 이 상수를 쓴다 (docs/conventions/api.md)
export const ApiVersion = {
  V1_BASE: 'api/v1',
  // 테스트·내부용. 운영 노출 금지 — local/test 환경에서만 모듈에 등록한다
  TEST_BASE: 'api/test',
} as const;
