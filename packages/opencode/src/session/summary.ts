import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

const MAX_DIFF_PATCH = 64 * 1024
const MAX_DIFF_TOTAL = 512 * 1024

/** 单条补丁 64KB、总补丁 512KB 封顶:summary.diffs 会随 message.updated 进入事件表
 *  (每条事件整包持久化并推给客户端),未封顶时一次可产生 MB 级事件,拖慢流式与存储。 */
export function capDiffs(diffs: Snapshot.FileDiff[]): Snapshot.FileDiff[] {
  let total = 0
  const out: Snapshot.FileDiff[] = []
  for (const item of diffs) {
    if (total >= MAX_DIFF_TOTAL) break
    const patch = item.patch
    const room = Math.min(MAX_DIFF_PATCH, MAX_DIFF_TOTAL - total)
    if (patch === undefined || patch.length <= room) {
      total += patch?.length ?? 0
      out.push(item)
      continue
    }
    const cut = patch.slice(0, room) + "\n…(diff truncated)"
    total += cut.length
    out.push({ ...item, patch: cut })
  }
  return out
}

/** 摘要补丁未变化时不重写消息:每次用户消息的 summary.diffs 会随 message.updated
 *  整包持久化并广播,重复写同一份补丁会让事件日志按更新次数倍增长(实测单条消息
 *  71 次更新只有 8 个不同版本,占事件库约 9 倍空间)。逐字段比较,顺序不同视为
 *  变化(保守:宁可多写一次)。 */
export function shouldUpdateSummaryDiffs(
  prev: readonly Snapshot.FileDiff[] | undefined,
  next: readonly Snapshot.FileDiff[],
): boolean {
  if (prev === undefined) return true
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!
    const b = next[i]!
    if (a.file !== b.file) return true
    if (a.additions !== b.additions) return true
    if (a.deletions !== b.deletions) return true
    if (a.patch !== b.patch) return true
  }
  return false
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const nextDiffs = capDiffs(yield* computeDiff({ messages }))
      // 未变化则零写入:否则同一份大补丁按更新次数重复持久化(事件库膨胀主因)。
      if (!shouldUpdateSummaryDiffs(target.info.summary?.diffs, nextDiffs)) return
      target.info.summary = { ...target.info.summary, diffs: nextDiffs }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const message = (yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
        (item) => item.info.id === input.messageID,
      )
      if (!message || message.info.role !== "user") return []
      const diffs = message.info.summary?.diffs ?? []
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node],
})

export * as SessionSummary from "./summary"
