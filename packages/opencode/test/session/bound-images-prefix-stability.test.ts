/**
 * boundImages 前缀稳定性:被替换的前缀必须逐字节稳定
 *
 * 上游(self-hosted)已有一个"keeps the replaced prefix stable"用例,但它断言的是
 * **被替换的数量**(removed(messages) === 4)。数量相等不等于前缀内容相等:
 * 若哪天 cut 的计算方式改动(例如改成"按消息条数切"而非"按字节切"),数量仍可能是 4,
 * 而实际被替换的位置/内容已变 → 供应商 prompt cache 失效,用户的 cache.read 归零。
 *
 * 本文件补的是更强的性质:**做前缀哈希**。
 *   P1 追加新图片、cut 未移动时,被替换前缀的 JSON 逐字节相同(哈希相等)
 *   P2 cut 移动时,新前缀是旧前缀的超集(只增不减),即不会"撤销"已替换的决定
 *   P3 同一输入多次调用结果完全一致(纯函数,无时间/随机依赖)
 *   P4 未触发阈值时返回**原数组同一引用**(不复制,不改变 token 估算路径的对象身份)
 */
import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { createHash } from "node:crypto"
import * as MessageV2 from "../../src/session/message-v2"

const image = (mib: number, filename: string): ModelMessage => ({
  role: "user",
  content: [{ type: "file", mediaType: "image/png", filename, data: "a".repeat(mib * 1024 * 1024) }],
})

/** 把"被替换成占位符的那些消息"序列化后取哈希(只看位置与替换结果,不看原文) */
const replacedPrefixHash = (messages: ModelMessage[]): string => {
  const bound = MessageV2.boundImages(messages)
  const replaced: unknown[] = []
  for (let i = 0; i < bound.length; i++) {
    const content = bound[i]!.content
    if (typeof content === "string") continue
    if (content[0]?.type === "text") {
      const text = (content[0] as { text: string }).text
      if (text.includes("image was removed")) replaced.push({ index: i, text })
    }
  }
  return createHash("sha256").update(JSON.stringify(replaced)).digest("hex")
}

const replacedCount = (messages: ModelMessage[]): number => {
  const bound = MessageV2.boundImages(messages)
  return bound.filter((m) => {
    const c = m.content
    if (typeof c === "string") return false
    return c[0]?.type === "text" && (c[0] as { text: string }).text.includes("image was removed")
  }).length
}

describe("goal: boundImages prefix stability (strict)", () => {
  test("P1 cut 未移动时,被替换前缀逐字节相同(不是只数量相同)", () => {
    const history = Array.from({ length: 9 }, (_, i) => image(3, `${i}.png`))
    const h0 = replacedPrefixHash(history)
    expect(replacedCount(history)).toBe(4)

    // 追加 1~3 张(不足以再次越过 trigger):前缀必须完全相同
    const h1 = replacedPrefixHash([...history, image(3, "9.png")])
    const h2 = replacedPrefixHash([...history, ...[9, 10, 11].map((i) => image(3, `${i}.png`))])

    expect(h1).toBe(h0)
    expect(h2).toBe(h0)
  })

  test("P2 cut 移动时新前缀是旧前缀的超集(不回退已替换决定)", () => {
    const history = Array.from({ length: 9 }, (_, i) => image(3, `${i}.png`))
    const before = MessageV2.boundImages(history)
    const after = MessageV2.boundImages([...history, ...[9, 10, 11, 12].map((i) => image(3, `${i}.png`))])

    // 旧前缀里所有被替换的位置,在新结果里必须仍是被替换的
    for (let i = 0; i < history.length; i++) {
      const b = before[i]!.content
      const a = after[i]!.content
      const wasReplaced =
        typeof b !== "string" && b[0]?.type === "text" && (b[0] as { text: string }).text.includes("image was removed")
      const stillReplaced =
        typeof a !== "string" && a[0]?.type === "text" && (a[0] as { text: string }).text.includes("image was removed")
      if (wasReplaced) expect(stillReplaced).toBe(true)
    }
    expect(replacedCount(after)).toBeGreaterThan(replacedCount(before))
  })

  test("P3 同一输入多次调用结果确定性(纯函数)", () => {
    const history = Array.from({ length: 12 }, (_, i) => image(3, `${i}.png`))
    const a = JSON.stringify(MessageV2.boundImages(history))
    const b = JSON.stringify(MessageV2.boundImages(history))
    const c = JSON.stringify(MessageV2.boundImages(structuredClone(history)))
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  test("P4 未越过阈值时返回同一数组引用(不复制)", () => {
    const messages = [image(1, "small.png")]
    expect(MessageV2.boundImages(messages)).toBe(messages)
  })

  test("P5 恰好等于 trigger 时不替换(边界:严格大于才触发)", () => {
    // 25 MiB 正好等于 IMAGE_BYTES_TRIGGER,`kept <= TRIGGER` 必须 continue
    const exact = [image(25, "exact.png")]
    expect(replacedCount(exact)).toBe(0)
    // 再多 1 MiB 就越过
    expect(replacedCount([image(25, "exact.png"), image(1, "over.png")])).toBeGreaterThan(0)
  })
})
