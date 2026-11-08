import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import type { Tool } from "ai"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, estimateRequestTokens, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

export const Event = SessionCompactionEvent

/**
 * 压缩请求只有在模型与父对话完全一致时才共享父请求的 tools:
 * 不同模型 = 不同前缀缓存域,且工具集可能不适用,必须回退为空集。
 */
export function sharesCompactionPrefix(
  parent: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
  compaction: Pick<Provider.Model, "providerID" | "id">,
) {
  return parent.providerID === compaction.providerID && parent.modelID === compaction.id
}

const ENV_BLOCK_PREFIX = "You are powered by the model named "

/**
 * 把环境块里的模型身份替换为压缩模型的身份;块内其余内容(工作目录/平台/日期)
 * 与原块一致,保持不变。非环境块原样返回。
 */
export function replaceEnvironmentBlock(block: string, model: Pick<Provider.Model, "id" | "providerID" | "api">) {
  if (!block.startsWith(ENV_BLOCK_PREFIX)) return block
  const firstLineEnd = block.indexOf("\n")
  const identity = `${ENV_BLOCK_PREFIX}${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`
  if (firstLineEnd < 0) return identity
  return identity + block.slice(firstLineEnd)
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
  id: MessageID
  hard: boolean
  soft: boolean
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(
  messages: SessionV1.WithParts[],
  pins?: { hard?: ReadonlySet<string>; soft?: ReadonlySet<string> },
) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    const partHard = msg.parts.some((part) => part.type === "text" && part.metadata?.pin === "hard")
    const partSoft = msg.parts.some((part) => part.type === "text" && part.metadata?.pin === "soft")
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
      hard: pins?.hard?.has(msg.info.id) === true || partHard,
      soft: pins?.soft?.has(msg.info.id) === true || partSoft,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
   readonly process: (input: {
     parentID: MessageID
     messages: SessionV1.WithParts[]
     sessionID: SessionID
     auto: boolean
     overflow?: boolean
     system?: string[]
     tools?: Record<string, Tool>
     /**
      * 与主请求同一份 session 权限。`LLMRequestPrep.resolveTools` 用
      * `Permission.merge(agent.permission, permission)` 过滤工具集,缺了它压缩请求
      * 保留的工具与主请求不同 → tools 前缀不一致,共享前缀失效。
      */
      permission?: PermissionV1.Ruleset
      /** 见 process 实现:被压缩的真实用户消息(带 per-request 覆盖)。 */
      requestUser?: SessionV1.User
    }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
      pins?: { hard?: ReadonlySet<string>; soft?: ReadonlySet<string> }
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages, input.pins)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        const effective = turn.soft ? Math.floor(size / 2) : size
        if (total + effective <= budget) {
          total += effective
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      // Hard pins are never summarized: move the retention boundary back to the
      // earliest pinned turn. This can exceed the soft budget, but the context
      // preflight still enforces the model hard limit.
      const earliestHard = all.find((turn) => turn.hard && (!keep || turn.start < keep.start))
      if (earliestHard) {
        if (keep && earliestHard.start < keep.start) {
          yield* Effect.logInfo("hard pin extends retained tail", {
            budget,
            total,
            start: earliestHard.start,
          })
        }
        keep = { start: earliestHard.start, id: earliestHard.id }
      }

      if (!keep) return { head: input.messages, tail_start_id: undefined }
      if (keep.start === 0) {
        if (all.some((turn) => turn.hard)) return { head: [], tail_start_id: keep.id }
        return { head: input.messages, tail_start_id: undefined }
      }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      system?: string[]
      /**
       * 与主对话相同的工具集。压缩请求携带同一份 tools,使
       * system + tools + history 前缀与主请求一致,从而命中供应商前缀缓存;
       * 同时 toolChoice="none" 保证压缩模型不会调用工具。
       */
      tools?: Record<string, Tool>
      /** 见 Interface.process:同一份 session 权限才能过滤出同一工具集。 */
      permission?: PermissionV1.Ruleset
      /**
       * 被压缩的真实用户消息(携带 per-request 的 system/tools/format 覆盖)。
       * `parentID` 指向压缩标记消息,而 `LLMRequestPrep.prepare` 会把
       * `input.user.system` 拼进 system、用 `input.user.tools` 过滤工具集;
       * 用标记建档会丢掉这两个字段 → system/tools 前缀与主请求不一致。
       */
      requestUser?: SessionV1.User
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const compactionAgent = yield* agents.get("compaction")
      const agent = (yield* agents.get(userMessage.agent)) ?? compactionAgent
      const model = compactionAgent.model
        ? yield* provider.getModel(compactionAgent.model.providerID, compactionAgent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      /**
       * 父请求的 system 中含 `SystemPrompt.environment` 生成的模型专属环境块
       * (system.ts 写入模型名与 provider/model id)。压缩换模型时该块事实错误,
       * 必须替换为压缩模型自己的环境块;其余块(AGENTS.md 指令、MCP 说明、skills)
       * 与模型无关,对压缩同样有效,必须保留 —— 整段丢弃会删掉工作区上下文。
       * 同模型时原样复用,保持共享前缀。
       */
      const sharedPrefix = sharesCompactionPrefix(userMessage.model, model)
      const system = sharedPrefix
        ? [...(input.system ?? [])]
        : (input.system ?? []).map((block) => replaceEnvironmentBlock(block, model))
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const pins = yield* plugin.trigger(
        "experimental.session.pin",
        { sessionID: input.sessionID, agent },
        { hard: [] as string[], soft: [] as string[] },
      )
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
        pins: { hard: new Set(pins.hard ?? []), soft: new Set(pins.soft ?? []) },
      })
      if (selected.head.length === 0 && selected.tail_start_id) {
        const message = "Compaction cannot proceed: all remaining context is hard-pinned"
        yield* events.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new SessionV1.ContextOverflowError({ message }).toObject(),
        })
        yield* plugin.trigger(
          "experimental.session.compaction.failed",
          { sessionID: input.sessionID, auto: input.auto, reason: "hard-pinned", message },
          {},
        )
        return "stop"
      }
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID, agent, auto: input.auto },
        { context: [], prompt: undefined },
      )
      const limit = usable({ cfg, model, outputTokenMax: flags.outputTokenMax })
      const tailIndex = selected.tail_start_id
        ? history.findIndex((msg) => msg.info.id === selected.tail_start_id)
        : -1
      let head = tailIndex >= 0 ? history.slice(0, tailIndex) : history
      let msgs = structuredClone(head)
      yield* plugin.trigger("experimental.chat.messages.transform", { sessionID: input.sessionID, agent, compaction: true }, { messages: msgs })
      // 插件自定义 prompt 需要旧形态(历史序列化进单条消息);默认走结构化历史,
      // 让压缩请求与主对话共享同一前缀,从而命中供应商的前缀缓存。
      const custom = compacting.prompt
      let conversation = custom ? msgs.map(serialize).filter(Boolean).join("\n\n") : ""
      const build = () =>
        custom ??
        [
          buildPrompt({
            context: [],
            embedded: true,
            priorInHistory: !!previousSummary,
          }),
          ...compacting.context,
          compactionAgent.prompt,
        ]
          .filter(Boolean)
          .join("\n\n")
      let nextPrompt = build()
      let historyMessages = custom ? [] : yield* MessageV2.toModelMessagesEffect(msgs, model)
      const sharedTools = sharedPrefix ? input.tools : undefined
      const tailText = () =>
        custom
          ? [nextPrompt, "The following is the conversation history:", conversation].filter(Boolean).join("\n\n")
          : nextPrompt
      /**
       * 必须按"最终请求"估算(system + messages + tools),否则加 tools 后低估,
       * 裁剪不足会向 provider 发送超限请求(llm.ts 硬门与 prompt.ts 预检同口径)。
       */
      const estimateRequest = () =>
        estimateRequestTokens({
          system,
          messages: [...historyMessages, { role: "user", content: [{ type: "text", text: tailText() }] }],
          tools: sharedTools,
        })
      let dropped = 0
      while (limit > 0 && estimateRequest() > limit && head.length > 1) {
        const all = turns(head, { hard: new Set(pins.hard ?? []), soft: new Set(pins.soft ?? []) })
        if (all.length <= 1) break
        if (all[0]?.hard) break
        head = head.slice(all[1]!.start)
        msgs = structuredClone(head)
        yield* plugin.trigger("experimental.chat.messages.transform", { sessionID: input.sessionID, agent, compaction: true }, { messages: msgs })
        if (custom) conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
        nextPrompt = build()
        if (!custom) historyMessages = yield* MessageV2.toModelMessagesEffect(msgs, model)
        dropped++
      }
      if (dropped > 0) {
        yield* Effect.logInfo("compaction trimmed head to fit context", {
          "session.id": input.sessionID,
          dropped,
          tokens: estimateRequest(),
          limit,
        })
      }
      if (limit > 0 && estimateRequest() > limit) {
        const message = "Compaction request exceeds the model context limit after trimming history"
        yield* events.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new SessionV1.ContextOverflowError({ message }).toObject(),
        })
        yield* plugin.trigger(
          "experimental.session.compaction.failed",
          { sessionID: input.sessionID, auto: input.auto, reason: "trim-limit", message },
          {},
        )
        return "stop"
      }
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: input.requestUser ?? userMessage,
        agent,
        sessionID: input.sessionID,
        permission: input.permission,
        tools: sharedTools ?? {},
        ...(sharedTools && input.tools ? { toolChoice: "none" as const } : {}),
        system,
        messages: [
          ...historyMessages,
          {
            role: "user",
            content: [
              {
                type: "text",
                text: tailText(),
              },
            ],
          },
        ],
        model,
      })

      if (result === "compact") {
        const message = replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media"
        processor.message.error = new SessionV1.ContextOverflowError({ message }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        yield* plugin.trigger(
          "experimental.session.compaction.failed",
          { sessionID: input.sessionID, auto: input.auto, reason: "compact-result", message },
          {},
        )
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      yield* plugin.trigger(
        "experimental.session.compacted",
        {
          sessionID: input.sessionID,
          auto: input.auto,
          result,
          summaryMessageID: processor.message.id,
          tokens: processor.message.tokens,
          cost: processor.message.cost,
          tailStartID: selected.tail_start_id,
          dropped,
        },
        {},
      )

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                agentInfo: agent,
                auto: input.auto,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) {
        yield* plugin.trigger(
          "experimental.session.compaction.failed",
          {
            sessionID: input.sessionID,
            auto: input.auto,
            reason: "agent-error",
            message: processor.message.error.name,
          },
          {},
        )
        return "stop"
      }
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
