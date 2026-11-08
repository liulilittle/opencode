import { describe, expect, test } from "bun:test"
import { capDiffs } from "../src/session/summary"

const diff = (patch: string, file = "a.ts") => ({ file, patch, additions: 1, deletions: 0 })

describe("capDiffs", () => {
  test("keeps small patches untouched", () => {
    const input = [diff("x".repeat(100))]
    const out = capDiffs(input)
    expect(out).toHaveLength(1)
    expect(out[0]!.patch).toBe("x".repeat(100))
  })

  test("truncates a single oversized patch", () => {
    const out = capDiffs([diff("y".repeat(200 * 1024))])
    expect(out).toHaveLength(1)
    expect(out[0]!.patch!.length).toBeLessThan(70 * 1024)
    expect(out[0]!.patch!.endsWith("…(diff truncated)")).toBe(true)
  })

  test("caps total size across files", () => {
    const input = Array.from({ length: 20 }, (_, i) => diff("z".repeat(60 * 1024), `f${i}.ts`))
    const out = capDiffs(input)
    const total = out.reduce((a, d) => a + (d.patch?.length ?? 0), 0)
    expect(total).toBeLessThanOrEqual(512 * 1024 + 32)
    expect(out.length).toBeLessThan(input.length)
  })

  test("keeps entries without patch", () => {
    const out = capDiffs([{ file: "b.ts", additions: 0, deletions: 0 }])
    expect(out).toHaveLength(1)
    expect(out[0]!.patch).toBeUndefined()
  })
})
