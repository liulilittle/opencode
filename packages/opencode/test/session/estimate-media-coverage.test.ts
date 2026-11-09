/**
 * estimateRequestTokens 必须把二进制 media 全部当占位符
 *
 * 现状(packages/opencode/src/session/overflow.ts:14-22):
 *   JSON.stringify(input, (_k, v) => {
 *     if (v instanceof Uint8Array) return "[media]"
 *     if (typeof v === "string" && v.startsWith("data:")) return "[media]"
 *     return v
 *   })
 * 只识别 Uint8Array 与 data: 字符串。
 *
 * 而 socket 层的 media 类型(见 message-v2.ts:520 `inlineBytes`
 * `data: string | URL | Uint8Array | ArrayBuffer`)明确包含 **ArrayBuffer**。
 * JSON.stringify 对 ArrayBuffer 没有特殊处理:它会按普通对象枚举索引,
 * 一个 1 MiB 的 ArrayBuffer 会变成 ~1,048,576 个 `"0":137,"1":80,...` 键值对,
 * 序列化后字符串膨胀数倍,token 估算直接爆炸 → 预检误判超限 → 提前压缩/裁剪,
 * 甚至把本可容纳的请求判成"必须压缩"。
 *
 * 断言:
 *   E1 Uint8Array 被替换为占位符(既有行为,回归锁)
 *   E2 data: 字符串被替换为占位符(既有行为)
 *   E3 ArrayBuffer 必须同样被替换为占位符
 *   E4 估算值不随二进制大小爆炸(1MiB 与 4MiB 的 Uint8Array 估算相同)
 *   E5 纯文本估算保持线性(不因修复而被压成常数)
 */
import { describe, expect, test } from "bun:test"
import { estimateRequestTokens } from "../../src/session/overflow"

const big = (mib: number) => new Uint8Array(mib * 1024 * 1024).fill(7)
const bigBuffer = (mib: number) => {
  const ab = new ArrayBuffer(mib * 1024 * 1024)
  new Uint8Array(ab).fill(7)
  return ab
}
const msg = (data: unknown) => [{ role: "user", content: [{ type: "image", image: data }] }]

describe("goal: estimateRequestTokens media placeholder coverage", () => {
  test("E1 Uint8Array 被替换为占位符(既有行为)", () => {
    const small = estimateRequestTokens({ messages: msg(big(1)) })
    const large = estimateRequestTokens({ messages: msg(big(4)) })
    expect(small).toBe(large)
  })

  test("E2 data: 字符串被替换为占位符(既有行为)", () => {
    // 必须放在**非 media part** 的位置:否则新加的裸 base64 守卫(key==="image" &&
    // isMediaPart)会兜住它,这条断言就测不到 data: 前缀分支(变异实测仍绿)。
    // 真实场景:某个非 media 字段里嵌了一个完整的 data URL。
    const sys = (n: number) => ["data:image/png;base64," + "A".repeat(n)]
    const a = estimateRequestTokens({ system: sys(1_000_000), messages: [] })
    const b = estimateRequestTokens({ system: sys(4_000_000), messages: [] })
    expect(a).toBe(b)
  })

  test("E3 ArrayBuffer 必须同样被替换为占位符", () => {
    const small = estimateRequestTokens({ messages: msg(bigBuffer(1)) })
    const large = estimateRequestTokens({ messages: msg(bigBuffer(4)) })
    expect(small).toBe(large)
  })

  test("E4 二进制估算不随大小爆炸(与纯文本量级可比)", () => {
    const bin = estimateRequestTokens({ messages: msg(bigBuffer(4)) })
    const plain = estimateRequestTokens({ messages: msg("hello world") })
    // 二进制必须落在占位符量级,不能因 4MiB 变成几十万 token
    expect(bin).toBeLessThan(plain * 10)
  })

  test("E5 纯文本估算仍随长度线性增长(防修复把估算压成常数)", () => {
    // 必须用 text part —— msg() 把载荷放在 image 字段,按新判据应被当 media(见 E7)
    const text = (n: number) => [{ role: "user", content: [{ type: "text", text: "x".repeat(n) }] }]
    const a = estimateRequestTokens({ messages: text(1_000) })
    const b = estimateRequestTokens({ messages: text(10_000) })
    expect(b).toBeGreaterThan(a * 5)
  })

  /**
   * E6: 裸 base64(无 data: 前缀)的口径必须与 boundImages/inlineBytes 一致。
   *
   * inlineBytes(message-v2.ts:520-524) 的注释写的是 "Base64 and data URLs are ASCII,
   * so a string's length is its size",实现是"任何非 http(s) 字符串都算内联字节"。
   * 但 estimateRequestTokens(overflow.ts:18) 只把 `data:` 前缀当 media。
   * 同一份二进制在两处被判成不同东西 → 若 media 以裸 base64 出现,
   * boundImages 正确计大小,而估算把它当普通文本(3.2 字符/token) →
   * 4MB base64 ≈ 125 万 token,预检必然误判超限并提前压缩/裁剪。
   *
   * 本断言锁"两处口径一致":裸 base64 也必须按占位符估算(不随长度爆炸)。
   */
  test("E6 裸 base64(无 data: 前缀)也按占位符估算,与 inlineBytes 口径一致", () => {
    const raw = (n: number) => "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(n)
    const small = estimateRequestTokens({ messages: [{ role: "user", content: [{ type: "image", image: raw(100_000) }] }] })
    const large = estimateRequestTokens({ messages: [{ role: "user", content: [{ type: "image", image: raw(4_000_000) }] }] })
    expect(large).toBe(small)
  })

  /**
   * E7: 反向保护 —— 普通长文本不得因为 E6 的修复被误当 media。
   * (修复只能放宽"image 字段位置"的识别,不能把任意长字符串都当占位符)
   */
  test("E7 普通长文本仍是文本(防止把任意字符串当 media)", () => {
    const a = estimateRequestTokens({ messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(100_000) }] }] })
    const b = estimateRequestTokens({ messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(400_000) }] }] })
    expect(b).toBeGreaterThan(a * 3)
  })
})
