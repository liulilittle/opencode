export type Delta = {
  sessionID: string
  messageID: string
  partID: string
  field: string
  text: string
}

export type PartSnapshot = {
  sessionID: string
  messageID: string
  partID: string
  part: unknown
}

export type AppliedPart = {
  sessionID: string
  messageID: string
  partID: string
  part?: unknown
  appends: { field: string; text: string }[]
}

type Entry = {
  sessionID: string
  messageID: string
  partID: string
  part?: unknown
  fields: Map<string, string>
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
  apply: (batch: AppliedPart[]) => void
  timer?: DeltaTimer
}) {
  const timer = options.timer ?? default_timer
  const pending = new Map<string, Entry>()
  const part_len = new Map<string, number>()
  let handle: unknown = null

  const delay_for = (partID: string): number => {
    const len = part_len.get(partID) ?? 0
    if (len >= 65536) return Math.max(options.base_ms, 150)
    if (len >= 16384) return Math.max(options.base_ms, 100)
    return options.base_ms
  }

  const entry_for = (d: { sessionID: string; messageID: string; partID: string }): Entry => {
    const cur = pending.get(d.partID)
    if (cur) return cur
    const next: Entry = { sessionID: d.sessionID, messageID: d.messageID, partID: d.partID, fields: new Map() }
    pending.set(d.partID, next)
    return next
  }

  const arm = (partID: string): void => {
    if (handle === null) handle = timer.setTimeout(flush, delay_for(partID))
  }

  const flush = (): void => {
    if (handle !== null) {
      timer.clearTimeout(handle)
      handle = null
    }
    if (pending.size === 0) return
    const entries = [...pending.values()]
    pending.clear()
    const batch: AppliedPart[] = []
    for (const e of entries) {
      for (const [field, text] of e.fields) part_len.set(e.partID, (part_len.get(e.partID) ?? 0) + text.length)
      batch.push({
        sessionID: e.sessionID,
        messageID: e.messageID,
        partID: e.partID,
        part: e.part,
        appends: [...e.fields].map(([field, text]) => ({ field, text })),
      })
    }
    options.apply(batch)
  }

  const queue = (d: Delta): void => {
    const entry = entry_for(d)
    entry.fields.set(d.field, (entry.fields.get(d.field) ?? "") + d.text)
    arm(d.partID)
  }

  /** 全量快照:包含此前已收到的增量,故清空待追加文本;快照后再到的增量照常追加。*/
  const queue_part = (d: PartSnapshot): void => {
    const entry = entry_for(d)
    entry.part = d.part
    entry.fields.clear()
    arm(d.partID)
  }

  return {
    queue,
    queue_part,
    flush,
    delay_for,
    pending_count: () => pending.size,
  }
}
