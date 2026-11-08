import { describe, expect, test } from "bun:test"
import { createDeltaQueue, type Delta, type DeltaTimer } from "../src/context/delta-queue"

function fakeClock() {
  let now = 0
  let seq = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const timer: DeltaTimer = {
    setTimeout: (fn, ms) => {
      const id = seq++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
  }
  return {
    timer,
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    scheduled: () => [...timers.values()].map((t) => t.at - now),
  }
}

const delta = (text: string, partID = "part-1"): Delta => ({
  sessionID: "ses-1",
  messageID: "msg-1",
  partID,
  field: "text",
  text,
})

describe("delta queue", () => {
  test("coalesces deltas of the same part into one apply", () => {
    const clock = fakeClock()
    const batches: Delta[][] = []
    const queue = createDeltaQueue({ base_ms: 60, apply: (b) => batches.push(b), timer: clock.timer })

    queue.queue(delta("hel"))
    queue.queue(delta("lo"))
    queue.queue(delta(" world"))
    expect(batches).toHaveLength(0)
    expect(queue.pending_count()).toBe(1)

    clock.advance(60)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
    expect(batches[0][0]!.text).toBe("hello world")
  })

  test("keeps separate parts separate within one batch", () => {
    const clock = fakeClock()
    const batches: Delta[][] = []
    const queue = createDeltaQueue({ base_ms: 60, apply: (b) => batches.push(b), timer: clock.timer })

    queue.queue(delta("a", "part-1"))
    queue.queue(delta("b", "part-2"))
    clock.advance(60)

    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((d) => d.text).sort()).toEqual(["a", "b"])
  })

  test("widens the window as the part grows", () => {
    const clock = fakeClock()
    const queue = createDeltaQueue({ base_ms: 60, apply: () => {}, timer: clock.timer })

    queue.queue(delta("x"))
    expect(clock.scheduled()).toEqual([60])
    clock.advance(60)

    queue.queue(delta("y".repeat(20_000)))
    expect(clock.scheduled()).toEqual([60])
    clock.advance(60)
    expect(queue.delay_for("part-1")).toBe(100)

    queue.queue(delta("z"))
    expect(clock.scheduled()).toEqual([100])
    clock.advance(100)

    queue.queue(delta("w".repeat(50_000)))
    clock.advance(100)
    expect(queue.delay_for("part-1")).toBe(150)

    queue.queue(delta("v"))
    expect(clock.scheduled()).toEqual([150])
  })

  test("flush applies immediately and arms a fresh timer afterwards", () => {
    const clock = fakeClock()
    const batches: Delta[][] = []
    const queue = createDeltaQueue({ base_ms: 60, apply: (b) => batches.push(b), timer: clock.timer })

    queue.queue(delta("a"))
    queue.flush()
    expect(batches).toHaveLength(1)
    expect(queue.pending_count()).toBe(0)

    clock.advance(60)
    expect(batches).toHaveLength(1)

    queue.queue(delta("b"))
    expect(clock.scheduled()).toEqual([60])
    clock.advance(60)
    expect(batches).toHaveLength(2)
    expect(batches[1]![0]!.text).toBe("b")
  })

  test("flush with nothing pending does not apply", () => {
    const batches: Delta[][] = []
    const queue = createDeltaQueue({ base_ms: 60, apply: (b) => batches.push(b) })
    queue.flush()
    expect(batches).toHaveLength(0)
  })

  test("single timer per batch window", () => {
    const clock = fakeClock()
    const queue = createDeltaQueue({ base_ms: 60, apply: () => {}, timer: clock.timer })
    for (let i = 0; i < 25; i++) queue.queue(delta("x"))
    expect(clock.scheduled()).toHaveLength(1)
  })
})
