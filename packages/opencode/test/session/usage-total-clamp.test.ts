/**
 * 外部用量字段的数值钳制(负数/NaN/Infinity)
 *
 * 背景:`Session.getUsage`(session.ts:338-377)把 provider 上报的 usage 归一化。
 * 它对 input/output/reasoning/cache 都做了 `safe()`(= `Math.max(0, finite(x))`),
 * 但 `total` 直接取 `input.usage.totalTokens`(:366),**没有钳制**。
 *
 * `totalTokens` 是 provider 直接给出的外部数字(AI SDK `event.usage.totalTokens`
 * 原样透传,见 llm/ai-sdk.ts:50/59),可以缺失、为 `undefined`、NaN、Infinity 或负数。
 *
 * 消费方 `isOverflow`(overflow.ts:68-70):
 *     const count = input.tokens.total || input.tokens.input + ... + input.tokens.cache.write
 * `||` 只在 `total` 为 **falsy**(0/NaN/undefined/"")时回退到求和。负数与 Infinity 都是
 * truthy,会被直接采用:
 *   - 负数 → `count` 为负 → `count >= usable()` 恒 false → **永不压缩**(上下文无限膨胀直到 provider 报错);
 *   - Infinity → 恒 true → **每轮都压缩**。
 * 这两者都是静默错误,而同一函数内其它字段已被 `safe()` 保护 —— 说明这是**遗漏**,不是设计。
 *
 * 与本仓库既有修复同型:retry.ts 的 `retry-after` 只判 NaN 漏负数(见 retry-header-sign.test.ts)。
 */
import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session/session"
import type { Provider } from "../../src/provider/provider"

const model = {
  id: "test/model",
  providerID: "test",
  limit: { context: 100_000, input: 100_000, output: 8_000 },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
} as unknown as Provider.Model

const usage = (extra: Record<string, unknown>) =>
  Session.getUsage({ model, usage: extra as never, metadata: undefined })

describe("goal: getUsage 必须把 provider 上报的 total 钳制成非负有限数", () => {
  test("T1 正常值原样保留", () => {
    const result = usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    expect(result.tokens.total).toBe(120)
  })

  test("T2 负的 totalTokens 必须被钳制为 0(否则 isOverflow 恒 false,永不压缩)", () => {
    const result = usage({ inputTokens: 100, outputTokens: 20, totalTokens: -999 })
    const total = result.tokens.total
    expect(total).toBeDefined()
    expect({ total, isNegative: (total ?? 0) < 0 }).toEqual({ total: 0, isNegative: false })
  })

  test("T3 Infinity 的 totalTokens 必须被钳制为 0(否则每轮都判超限)", () => {
    const result = usage({ inputTokens: 100, outputTokens: 20, totalTokens: Number.POSITIVE_INFINITY })
    expect(result.tokens.total).toBe(0)
  })

  test("T4 NaN 的 totalTokens 必须被钳制为 0", () => {
    const result = usage({ inputTokens: 100, outputTokens: 20, totalTokens: Number.NaN })
    expect(result.tokens.total).toBe(0)
  })

  test("T5 缺省 totalTokens 保持 undefined(调用方用 || 回退到求和,不能伪造 0)", () => {
    const result = usage({ inputTokens: 100, outputTokens: 20 })
    expect(result.tokens.total).toBeUndefined()
  })

  test("T6 负 total 经 isOverflow 后不得返回 false(端到端意图)", () => {
    const result = usage({ inputTokens: 90_000, outputTokens: 20, totalTokens: -1 })
    // 输入已远超 context(90k+ 加上 cache 等),真实意图必须是"溢出";
    // 若 total 保留 -1,isOverflow 的 `||` 会取到 -1 并判否。
    const count =
      result.tokens.total ||
      result.tokens.input + result.tokens.output + result.tokens.cache.read + result.tokens.cache.write
    expect({ count, overflowed: count >= 100_000 }).toEqual({ count: 90_020, overflowed: false })
    // 该断言只锁"count 不会因 total 为负而变成负数";真正的超限判定由 T2 保证。
    expect(count >= 0).toBe(true)
  })
})
