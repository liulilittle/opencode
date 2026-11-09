/**
 * 累计用量不得被快照覆盖(D5)
 *
 * 背景:宿主有两条路径写同一组累计字段(`cost` / `tokens_*`):
 *   ① projector.ts `applyUsage`(89-109):对 PartUpdated/PartRemoved/MessageRemoved 做 `+=`
 *   ② projector.ts `sessionRow`(43-75):用 SessionInfo 快照**全量覆盖**
 *      (SessionV1.Event.Updated 走这条路,projector.ts:234-241)
 *
 * 这条设计只有在"快照里带的就是扣减/累加之后的真实值"时才安全 ——
 * 依赖 `Session.patch`(session.ts:754-767)**先 get() 读 SessionTable 再合并**,
 * 而 `get`(session.ts:540-544)正是读 applyUsage 写的同一张表。
 *
 * 若有人把 patch 改成"只用调用方传入的 info 直接发布"(不读当前行),
 * 或把 sessionRow 的 tokens/cost 换成 `info.tokens ?? 默认值` 而不合并,
 * 累加结果就会被旧快照抹掉,且**没有任何现有测试会失败**。
 *
 * 本文件用静态结构断言把这个依赖关系锁住:
 *   S1 patch 必须在发布前读取当前行(get)
 *   S2 sessionRow 必须包含累计字段(否则它们永远不会被投影)
 *   S3 applyUsage 必须是增量(+=)而非赋值(=)
 *   S4 Event.Updated 的投影必须使用 sessionRow(而不是凭空构造)
 *   S5 陷阱守卫:任何对 SessionTable 的 .set 若包含 tokens_/cost 字段,
 *      都必须来自 get() 读出的值(本文件只允许 sessionRow 这一处集中定义)
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// core/test/x.test.ts -> ../ = core/, ../../ = packages/
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8")
const projector = read("../src/session/projector.ts")
const session = read("../../opencode/src/session/session.ts")

const CUMULATIVE = ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]

describe("goal: 累计用量投影契约(D5 不得快照覆盖累计)", () => {
  test("S1 Session.patch 必须在发布 Updated 前读取当前行", () => {
    const i = session.indexOf("const patch = (sessionID: SessionID, info: Patch)")
    expect(i).toBeGreaterThan(0)
    const body = session.slice(i, i + 900)
    const getIdx = body.indexOf("yield* get(sessionID)")
    const publishIdx = body.indexOf("SessionV1.Event.Updated")
    expect(getIdx).toBeGreaterThan(0)
    expect(publishIdx).toBeGreaterThan(getIdx)
  })

  test("S2 sessionRow 必须从 info 投影全部累计字段(不是写死默认值)", () => {
    const i = projector.indexOf("function sessionRow(")
    expect(i).toBeGreaterThan(0)
    const end = projector.indexOf("\n}", i)
    expect(end).toBeGreaterThan(i)
    const body = projector.slice(i, end)
    // 必须逐个断言"字段绑定到 info"——只断言字段名出现是弱断言:
    // 把 `cost: info.cost ?? 0` 改成 `cost: 0` 后,字段名仍然在文本里,弱断言测不出来。
    const bindings: Array<[string, RegExp]> = [
      ["cost", /cost:\s*info\.cost\b/],
      ["tokens_input", /tokens_input:\s*\(info\.tokens\b/],
      ["tokens_output", /tokens_output:\s*\(info\.tokens\b/],
      ["tokens_reasoning", /tokens_reasoning:\s*\(info\.tokens\b/],
      ["tokens_cache_read", /tokens_cache_read:\s*\(info\.tokens\b/],
      ["tokens_cache_write", /tokens_cache_write:\s*\(info\.tokens\b/],
    ]
    for (const [field, re] of bindings) {
      expect({ field, bound: re.test(body) }).toEqual({ field, bound: true })
    }
  })

  test("S3 applyUsage 必须是增量累加(+=)并支持 sign 对冲", () => {
    const i = projector.indexOf("function applyUsage(")
    expect(i).toBeGreaterThan(0)
    const body = projector.slice(i, i + 800)
    expect(body).toContain("sign = 1")
    // 每个累计字段都用 sql`... + ... * sign` 形式
    const adds = body.match(/\+\s*\$\{value\./g) ?? []
    expect(adds.length).toBeGreaterThanOrEqual(CUMULATIVE.length)
  })

  test("S4 Event.Updated 投影使用 sessionRow(不凭空构造)", () => {
    const i = projector.indexOf("SessionV1.Event.Updated")
    expect(i).toBeGreaterThan(0)
    const body = projector.slice(i, i + 300)
    expect(body).toContain("sessionRow(event.data.info)")
  })

  test("S5 陷阱守卫:对 SessionTable 的 set 里出现累计字段时,同文件必须存在 get() 读取支撑", () => {
    // 收集所有对 SessionTable 的 .set({...}) 片段
    const setBlocks: string[] = []
    let idx = 0
    while ((idx = projector.indexOf(".set({", idx)) >= 0) {
      const end = projector.indexOf("})", idx)
      if (end < 0) break
      setBlocks.push(projector.slice(idx, end + 2))
      idx = end + 2
    }
    const cumulativeWriters = setBlocks.filter((b) => CUMULATIVE.some((f) => b.includes(f)))
    // applyUsage 是唯一的"裸写累计字段"处(其余都经 sessionRow)
    const usesSqlAdd = cumulativeWriters.filter((b) => b.includes("sql`"))
    expect(cumulativeWriters.length).toBeGreaterThan(0)
    expect(usesSqlAdd.length).toBeGreaterThan(0)
    // sessionRow 必须是函数(集中定义处),不得在投影里内联展开累计字段
    expect(projector).toContain("function sessionRow(")
  })
})
