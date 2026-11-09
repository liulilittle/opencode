import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Token } from "@/util/token"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

const COMPACTION_BUFFER = 20_000

/** media part 的形态:AI SDK 的 image/file part 与工具结果里的 media 项。 */
const isMediaPart = (holder: unknown): boolean => {
  if (typeof holder !== "object" || holder === null) return false
  const t = (holder as { type?: unknown }).type
  return t === "image" || t === "file" || t === "media"
}

/**
 * Estimates request tokens from text only. Binary payloads and data URLs are
 * replaced with a placeholder so media attachments do not look like millions
 * of text tokens to the preflight.
 *
 * 裸 base64 也必须被替换:AI SDK 的 `DataContent` 允许
 * `string | Uint8Array | ArrayBuffer | Buffer`(其中 string 是**不带 data: 前缀**的
 * base64),而 message-v2.ts:223-227 处理工具结果附件时,正是把
 * `data:image/png;base64,XXXX` 的逗号前缀剥掉、只留裸 base64 作为 `data`。
 * 只认 `data:` 前缀会让这类图片按普通文本估算(3.2 字符/token),一张 4MB 图片
 * 估成上百方 token,预检必然误判超限并提前压缩/裁掉本可保留的上下文。
 *
 * 判据按**所在 part 的类型**识别,而不是"看起来像不是一个字符串"——
 * 否则任何长文本都会被当成 media(见测试 E7)。
 */
export function estimateRequestTokens(input: { system?: readonly string[]; messages: unknown; tools?: unknown }) {
  return Token.estimate(
    JSON.stringify(input, function (this: unknown, key, value) {
      if (value instanceof Uint8Array) return "[media]"
      // ArrayBuffer 目前会被 JSON 序列化成 {}，但不要依赖这个巧合。
      if (value instanceof ArrayBuffer) return "[media]"
      if (typeof value === "string") {
        if (value.startsWith("data:")) return "[media]"
        // 裸 base64:仅当字符串位于 media part 的载荷字段上时才替换。
        if ((key === "image" || key === "data") && isMediaPart(this)) return "[media]"
      }
      return value
    }),
  )
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
