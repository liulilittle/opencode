export type Delta = {
  sessionID: string
  messageID: string
  partID: string
  field: string
  text: string
}

export type DeltaTimer = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const default_timer: DeltaTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createDeltaQueue(options: {
  base_ms: number
  apply: (batch: Delta[]) => void
  timer?: DeltaTimer
}) {
  const timer = options.timer ?? default_timer
  const pending = new Map<string, Delta>()
  const part_len = new Map<string, number>()
  let handle: unknown = null

  const delay_for = (partID: string): number => {
    const len = part_len.get(partID) ?? 0
    if (len >= 65536) return Math.max(options.base_ms, 150)
    if (len >= 16384) return Math.max(options.base_ms, 100)
    return options.base_ms
  }

  const flush = (): void => {
    if (handle !== null) {
      timer.clearTimeout(handle)
      handle = null
    }
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    for (const d of batch) part_len.set(d.partID, (part_len.get(d.partID) ?? 0) + d.text.length)
    options.apply(batch)
  }

  const queue = (d: Delta): void => {
    const cur = pending.get(d.partID)
    if (cur) cur.text += d.text
    else pending.set(d.partID, { ...d })
    if (handle === null) handle = timer.setTimeout(flush, delay_for(d.partID))
  }

  return {
    queue,
    flush,
    delay_for,
    pending_count: () => pending.size,
  }
}
