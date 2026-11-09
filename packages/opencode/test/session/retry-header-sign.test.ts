/**
 * retry-after 头部必须是正数才作为退避时间
 *
 * 现状(packages/opencode/src/session/retry.ts:47-78 `delay`):
 *   - `retry-after-ms` 只判 `!Number.isNaN(parsedMs)`,**不判正负** → `cap(负数)` 返回负数
 *   - `retry-after`(秒)同样只判 NaN → `cap(Math.ceil(负数*1000))` 返回负数
 *   - 但 HTTP-date 分支(:68)有 `parsed > 0` 守卫 → **同一函数内两套判据不一致**
 *
 * 后果:上游返回 `retry-after: -1` 或 `retry-after-ms: -5000`(时钟偏差/占位响应/网关
 * 注入)时,退避被算成负数。`Duration.millis(负数)` 在 Effect 调度器里等价于"立即到期",
 * 于是 5 次重试在毫秒内全部烧完 —— provider 过载时不但没有退避,反而瞬间打完重试额度,
 * 把一次可恢复的 429 变成硬失败。
 *
 * 断言:
 *   D1 负的 retry-after-ms 不得产出负延迟(必须退化到指数退避,与 HTTP-date 分支一致)
 *   D2 负的 retry-after(秒)同理
 *   D3 合法的 0 仍保持 0(既有用例依赖它做快速测试,不能改成指数退避)
 *   D4 正值行为不变(回归锁)
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "../../src/session/retry"

const apiError = (headers: Record<string, string>) =>
  Schema.decodeUnknownSync(SessionV1.APIError.Schema)({
    name: "APIError",
    data: { message: "boom", isRetryable: true, responseHeaders: headers },
  })

/** 无抖动的指数退避基准(attempt=1 → 2000, attempt=4 → 16000) */
const EXPONENTIAL_NO_JITTER = (attempt: number) => SessionRetry.RETRY_INITIAL_DELAY * Math.pow(SessionRetry.RETRY_BACKOFF_FACTOR, attempt - 1)

describe("goal: retry-after header sign handling", () => {
  test("D1 负 retry-after-ms 必须退化为指数退避(不得返回负延迟)", () => {
    const error = apiError({ "retry-after-ms": "-5000" })
    const d = SessionRetry.delay(1, error, 0)
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBe(EXPONENTIAL_NO_JITTER(1))
  })

  test("D2 负 retry-after 秒必须退化为指数退避", () => {
    const error = apiError({ "retry-after": "-30" })
    const d = SessionRetry.delay(2, error, 0)
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBe(EXPONENTIAL_NO_JITTER(2))
  })

  test("D3 合法的 0 仍保持 0(既有快速测试依赖,不得改成指数退避)", () => {
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": "0" }), 0)).toBe(0)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "0" }), 0)).toBe(0)
  })

  test("D4 合法正值行为不变(回归锁)", () => {
    expect(SessionRetry.delay(4, apiError({ "retry-after-ms": "1500" }), 0)).toBe(1500)
    expect(SessionRetry.delay(3, apiError({ "retry-after": "30" }), 0)).toBe(30000)
  })

  test("D5 未带头部时行为不变(30s 上限 + 抖动)", () => {
    const d = SessionRetry.delay(1, undefined, 0)
    expect(d).toBe(EXPONENTIAL_NO_JITTER(1))
    // 无头部时指数退避封顶 30s
    expect(SessionRetry.delay(20, undefined, 0)).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
  })
})
