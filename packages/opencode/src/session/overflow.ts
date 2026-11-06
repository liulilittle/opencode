import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Token } from "@/util/token"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

const COMPACTION_BUFFER = 20_000

/**
 * Estimates request tokens from text only. Binary payloads and data URLs are
 * replaced with a placeholder so media attachments do not look like millions
 * of text tokens to the preflight.
 */
export function estimateRequestTokens(input: { system?: readonly string[]; messages: unknown; tools?: unknown }) {
  return Token.estimate(
    JSON.stringify(input, (_key, value) => {
      if (value instanceof Uint8Array) return "[media]"
      if (typeof value === "string" && value.startsWith("data:")) return "[media]"
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
