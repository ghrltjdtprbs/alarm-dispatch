/**
 * 동시 요청 재현 유틸 — 발송 시작/취소 경합, 중복 claim 방지 등 검증용.
 * 모든 작업을 같은 틱에 출발시켜 실제 경합 확률을 높인다.
 *
 * const result = await runConcurrently(10, (i) => service.start(alarmId));
 * expect(result.successCount).toBe(1);
 * expect(result.countFailures(ConflictException)).toBe(9);
 */
export interface ConcurrencyResult {
  successCount: number;
  failures: unknown[];
  failureCount: number;
  countFailures: (type: abstract new (...args: never[]) => unknown) => number;
}

export async function runConcurrently(
  taskCount: number,
  task: (index: number) => Promise<unknown>,
): Promise<ConcurrencyResult> {
  // 1. 출발 신호 전까지 모든 작업을 대기시킨다
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const settled = Promise.allSettled(
    Array.from({ length: taskCount }, async (_, i) => {
      await gate;
      return task(i);
    }),
  );

  // 2. 동시 출발 후 결과 집계 (교착 시 무한 대기하지 않도록 상한)
  release();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('동시성 테스트가 30초 안에 끝나지 않았습니다. 교착 상태를 확인하세요.')),
      30_000,
    ).unref(),
  );
  const results = await Promise.race([settled, timeout]);

  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown);
  return {
    successCount: results.length - failures.length,
    failures,
    failureCount: failures.length,
    countFailures: (type) => failures.filter((f) => f instanceof type).length,
  };
}
