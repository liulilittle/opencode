import { describe, expect, test } from "bun:test"
import { prefixHash, restoreMessages, restoreSystem, snapshot } from "../../src/session/prefix"

const message = (id: string, text: string) => ({
  info: { id },
  parts: [{ type: "text", text }],
})

describe("session prefix", () => {
  test("restores a mutated historical message and keeps appended tail messages", () => {
    const messages = [message("u1", "one"), message("a1", "two")]
    const before = snapshot(messages, [])
    messages[0].parts[0].text = "changed"
    messages.push(message("u2", "tail"))

    expect(restoreMessages(messages, before)).toBe(1)
    expect(messages.map((item) => item.info.id)).toEqual(["u1", "a1", "u2"])
    expect(messages[0].parts[0].text).toBe("one")
    expect(messages[2].parts[0].text).toBe("tail")
  })

  test("leaves an unchanged prefix untouched", () => {
    const messages = [message("u1", "one")]
    const before = snapshot(messages, [])
    messages.push(message("a1", "tail"))

    expect(restoreMessages(messages, before)).toBe(0)
    expect(messages.map((item) => item.info.id)).toEqual(["u1", "a1"])
  })

  test("keeps prepended parts on the first historical message", () => {
    const messages = [message("u1", "one"), message("a1", "two")]
    const before = snapshot(messages, [])
    messages[0].parts.unshift({ type: "text", text: "bootstrap" })

    expect(restoreMessages(messages, before)).toBe(0)
    expect(messages[0].parts.map((part) => part.text)).toEqual(["bootstrap", "one"])
    expect(messages[1].parts[0].text).toBe("two")
  })

  test("restores a rewrite on the first historical message", () => {
    const messages = [message("u1", "one")]
    const before = snapshot(messages, [])
    messages[0].parts[0].text = "changed"

    expect(restoreMessages(messages, before)).toBe(1)
    expect(messages[0].parts[0].text).toBe("one")
  })

  test("restores appended parts on a later historical message", () => {
    const messages = [message("u1", "one"), message("a1", "two")]
    const before = snapshot(messages, [])
    messages[1].parts.push({ type: "text", text: "late" })

    expect(restoreMessages(messages, before)).toBe(1)
    expect(messages[1].parts.map((part) => part.text)).toEqual(["two"])
  })

  test("restores a removed historical message", () => {
    const messages = [message("u1", "one"), message("a1", "two")]
    const before = snapshot(messages, [])
    messages.shift()

    expect(restoreMessages(messages, before)).toBe(1)
    expect(messages.map((item) => item.info.id)).toEqual(["u1", "a1"])
  })

  test("accepts appended system blocks but restores a changed prefix", () => {
    const system = ["base"]
    const before = snapshot([], system)
    system.push("tail")
    expect(restoreSystem(system, before)).toBe(0)
    expect(system).toEqual(["base", "tail"])

    system[0] = "changed"
    expect(restoreSystem(system, before)).toBe(1)
    expect(system).toEqual(["base"])
  })

  test("prefix hash ignores appended tail messages and changes with the prefix", () => {
    const messages = [message("u1", "one")]
    const base = prefixHash({ system: ["s"], tools: {}, messages, messageCount: 1 })
    messages.push(message("u2", "tail"))
    const appended = prefixHash({ system: ["s"], tools: {}, messages, messageCount: 1 })
    const changed = prefixHash({ system: ["s"], tools: {}, messages: [message("u1", "two")], messageCount: 1 })

    expect(appended).toBe(base)
    expect(changed).not.toBe(base)
  })
})
