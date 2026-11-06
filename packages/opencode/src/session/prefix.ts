import { createHash } from "node:crypto"

export type PrefixMessage = {
  info: { id: string }
  parts?: unknown[]
}

type Snapshot = {
  messages: Map<string, PrefixMessage>
  order: string[]
  system: string[]
}

const serialize = (value: unknown) => JSON.stringify(value)

/**
 * Captures the request prefix before plugin hooks run. Existing messages are
 * deep-cloned so a later comparison cannot be fooled by in-place mutation.
 */
export function snapshot(messages: readonly PrefixMessage[], system: readonly string[]): Snapshot {
  return {
    messages: new Map(messages.map((message) => [message.info.id, structuredClone(message)])),
    order: messages.map((message) => message.info.id),
    system: system.slice(),
  }
}

const prependedParts = (original: PrefixMessage, now: PrefixMessage) => {
  if (serialize(original.info) !== serialize(now.info)) return false
  if (!Array.isArray(original.parts) || !Array.isArray(now.parts)) return false
  if (now.parts.length < original.parts.length) return false
  const offset = now.parts.length - original.parts.length
  return original.parts.every((part, index) => serialize(part) === serialize(now.parts![offset + index]))
}

/**
 * Restores every message that existed before the hook and preserves messages
 * appended at the tail. A plugin may prepend parts to the first historical
 * message (V1 bootstrap injection) as long as the original parts stay intact;
 * any rewrite or removal is restored. Returns the number of restored messages.
 */
export function restoreMessages(messages: PrefixMessage[], before: Snapshot): number {
  const current = new Map(messages.map((message) => [message.info.id, message]))
  const known = new Set(before.order)
  let violations = 0
  const restored = before.order.map((id, index) => {
    const original = before.messages.get(id)!
    const now = current.get(id)
    if (now && serialize(now) === serialize(original)) return now
    if (now && index === 0 && prependedParts(original, now)) return now
    violations++
    return structuredClone(original)
  })
  for (const message of messages) {
    if (!known.has(message.info.id)) restored.push(message)
  }
  messages.splice(0, messages.length, ...restored)
  return violations
}

/**
 * Keeps the original system prefix byte-identical. Appended blocks are
 * allowed; a changed, removed, or reordered prefix restores the snapshot and
 * drops every hook change.
 */
export function restoreSystem(system: string[], before: Snapshot): number {
  const original = before.system
  const prefixIntact =
    system.length >= original.length && original.every((value, index) => system[index] === value)
  if (prefixIntact) return 0
  system.splice(0, system.length, ...original)
  return 1
}

/**
 * Stable hash of the cacheable prefix. `messageCount` is the number of
 * historical messages included; appended tail messages are excluded.
 */
export function prefixHash(input: {
  system: readonly string[]
  tools: Readonly<Record<string, unknown>>
  messages: readonly PrefixMessage[]
  messageCount: number
}): string {
  const tools = Object.keys(input.tools)
    .toSorted()
    .map((name) => [name, input.tools[name]] as const)
  return createHash("sha256")
    .update(
      serialize({
        system: input.system,
        tools,
        messages: input.messages.slice(0, input.messageCount).map(serialize),
      }),
    )
    .digest("hex")
}
