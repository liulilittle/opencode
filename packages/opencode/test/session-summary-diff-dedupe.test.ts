import { describe, expect, test } from "bun:test"
import { shouldUpdateSummaryDiffs } from "../src/session/summary"

const diff = (patch: string, file = "a.ts", additions = 1, deletions = 0) => ({
  file,
  patch,
  additions,
  deletions,
})

describe("shouldUpdateSummaryDiffs", () => {
  test("首次写入(无历史补丁)必须写", () => {
    expect(shouldUpdateSummaryDiffs(undefined, [diff("p")])).toBe(true)
    expect(shouldUpdateSummaryDiffs(undefined, [])).toBe(true)
  })

  test("补丁逐字段相同 → 不重写(防事件日志按更新次数倍增长)", () => {
    const prev = [diff("x", "a.ts", 2, 1), diff("y", "b.ts", 0, 3)]
    const next = [diff("x", "a.ts", 2, 1), diff("y", "b.ts", 0, 3)]
    expect(shouldUpdateSummaryDiffs(prev, next)).toBe(false)
  })

  test("补丁内容变化 → 必须重写", () => {
    expect(shouldUpdateSummaryDiffs([diff("x")], [diff("x2")])).toBe(true)
  })

  test("文件名变化 → 必须重写", () => {
    expect(shouldUpdateSummaryDiffs([diff("x", "a.ts")], [diff("x", "b.ts")])).toBe(true)
  })

  test("增删行数变化 → 必须重写", () => {
    expect(shouldUpdateSummaryDiffs([diff("x", "a.ts", 1, 0)], [diff("x", "a.ts", 2, 0)])).toBe(true)
    expect(shouldUpdateSummaryDiffs([diff("x", "a.ts", 1, 0)], [diff("x", "a.ts", 1, 1)])).toBe(true)
  })

  test("条数变化 → 必须重写", () => {
    expect(shouldUpdateSummaryDiffs([diff("x")], [diff("x"), diff("y", "b.ts")])).toBe(true)
    expect(shouldUpdateSummaryDiffs([diff("x"), diff("y", "b.ts")], [diff("x")])).toBe(true)
  })

  test("顺序变化视为变化(保守,不误判为相同)", () => {
    expect(shouldUpdateSummaryDiffs([diff("x", "a.ts"), diff("y", "b.ts")], [diff("y", "b.ts"), diff("x", "a.ts")])).toBe(true)
  })
})
