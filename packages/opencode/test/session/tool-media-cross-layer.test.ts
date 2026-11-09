/**
 * 跨层形态契约:工具结果附件剥前缀 与 估算识别 必须同源
 *
 * 第 60 轮修复的根因是两处对"内联二进制"的形态判断不一致:
 *   - message-v2.ts:223-227 把 `data:image/png;base64,XXXX` 在逗号处切开,
 *     只留**裸 base64** 作为 media part 的 data;
 *   - 而 estimateRequestTokens 原来只认 `data:` 前缀。
 * 修复后估算侧已覆盖裸 base64,但这条契约只存在于两处代码的"巧合一致"里。
 *
 * 本文件用**真实的 toModelMessagesEffect 输出**喂养 estimateRequestTokens,
 * 断言"工具结果里的图片不会让估算爆炸"。这样任何一个环节改动形态
 * (剥前缀方式变了 / 估算判据收窄了)都会立刻变红。
 *
 * G1 工具结果里的图片:估算值不随 base64 长度增长
 * G2 同一输入的控制组(纯文本工具结果):估算值随文本增长
 * G3 估算结果与手写"占位符版本"的数量级一致(不是"恰好通过"而是真的把图片当 media)
 */
import { describe, expect, test } from "bun:test"
import * as MessageV2 from "../../src/session/message-v2"
import { estimateRequestTokens } from "../../src/session/overflow"

/** 造一条带图片附件的工具消息(与 SessionV1 的实际形状一致) */
const toolMessageWithImage = (base64Len: number) => {
  const base64 = "iVBORw0KGgo" + "A".repeat(base64Len)
  return [
    {
      info: {
        id: "msg_tool" as never,
        sessionID: "ses_test" as never,
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: "msg_parent" as never,
        modelID: "m",
        providerID: "p",
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_tool" as never,
          sessionID: "ses_test" as never,
          messageID: "msg_tool" as never,
          type: "tool" as const,
          callID: "call_1",
          tool: "read",
          state: {
            status: "completed" as const,
            input: {},
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
            output: "",
            attachments: [
              { mime: "image/png", url: `data:image/png;base64,${base64}` },
            ],
          },
        },
      ],
    },
  ] as never
}

const model = {
  id: "test-model",
  providerID: "test",
  api: { npm: "@ai-sdk/anthropic", id: "test", url: "", env: [] },
  capabilities: { attachment: true, reasoning: false, temperature: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: true }, output: { text: true, audio: false, image: false, video: false, pdf: false } },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, input: 180_000, output: 8_000 },
  name: "test",
  npm: "@ai-sdk/anthropic",
  options: {},
  release_date: "2024-01-01",
  status: "active",
} as never

describe("goal: tool-result media 跨层形态契约", () => {
  test("G1 工具结果里的图片不让估算随 base64 长度爆炸", async () => {
    // 必须用 toModelMessages(Promise 版):toModelMessagesEffect 返回的是 Effect 对象,
    // 直接比较两个 Effect 对象会恒等 —— 那是假测试(本文件初版踩过)。
    const small = await MessageV2.toModelMessages(toolMessageWithImage(100_000), model)
    const large = await MessageV2.toModelMessages(toolMessageWithImage(4_000_000), model)

    // 先证明转换真的产出了内容(否则"相等"可能只是都为空)
    expect(Array.isArray(small)).toBe(true)
    expect(small.length).toBeGreaterThan(0)

    const a = estimateRequestTokens({ messages: small })
    const b = estimateRequestTokens({ messages: large })
    expect(a).toBeGreaterThan(0)
    expect(b).toBe(a)
  })

  test("G2 纯文本工具结果的估算仍随内容增长(控制组)", async () => {
    const mk = (len: number) =>
      [
        {
          info: {
            id: "msg_tool2" as never,
            sessionID: "ses_test" as never,
            role: "assistant" as const,
            time: { created: Date.now() },
            parentID: "msg_parent" as never,
            modelID: "m",
            providerID: "p",
            mode: "build",
            agent: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: "prt_tool2" as never,
              sessionID: "ses_test" as never,
              messageID: "msg_tool2" as never,
              type: "tool" as const,
              callID: "call_2",
              tool: "bash",
              state: {
                status: "completed" as const,
                input: {},
                title: "bash",
                metadata: {},
                time: { start: 0, end: 1 },
                output: "z".repeat(len),
                attachments: [],
              },
            },
          ],
        },
      ] as never

    const small = await MessageV2.toModelMessages(mk(1_000), model)
    const large = await MessageV2.toModelMessages(mk(40_000), model)
    const a = estimateRequestTokens({ messages: small })
    const b = estimateRequestTokens({ messages: large })
    expect(b).toBeGreaterThan(a * 3)
  })

  test("G3 图片被真的当 media(估算量级与占位符版本一致)", async () => {
    const converted = await MessageV2.toModelMessages(toolMessageWithImage(4_000_000), model)
    const withImage = estimateRequestTokens({ messages: converted })
    // 把同一结构里的二进制换成极短占位符作为对照
    const placeholder = [{ role: "user", content: [{ type: "text", text: "placeholder" }] }]
    const baseline = estimateRequestTokens({ messages: placeholder })
    // 图片版的估算必须在同一量级(允许结构开销),不能是几十万 token
    expect(withImage).toBeLessThan(baseline * 200)
  })
})
