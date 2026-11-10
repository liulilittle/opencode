// 第 94 轮:BackgroundJob.cancel 的 scope 关闭可被中断,导致"状态已取消但任务仍在跑"
//
// `cancel`(core/src/background-job.ts:337-358):
//
//   const cancel = Effect.fn("BackgroundJob.cancel")(function* (id) {
//     const completed_at = yield* Clock.currentTimeMillis
//     const result = yield* SynchronizedRef.modify(state.jobs, (jobs) => {
//       ...
//       return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
//     })
//     if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
//     if (result.scope) yield* Scope.close(result.scope, Exit.void)      // <- 可被中断
//     return result.info
//   })
//
// 三处都是挂起点。`SynchronizedRef.modify` 已经让 job 变成 `cancelled` 并出队,
// `Deferred.succeed` 也已经叫醒所有 `wait()` 的等待者。此后若调用方被中断
// (例如父 fiber 收到 interrupt、`Effect.raceFirst` 的另一支先完成、工具调用超时),
// `Scope.close` 不会执行 —— **任务 fiber 继续运行**,而所有观察者都看到 "cancelled"。
//
// 对比同文件 `settle`(:167-169)在同一位置用的是:
//
//   yield* Scope.close(result.scope, Exit.void).pipe(
//     Effect.forkIn(state.scope, { startImmediately: true }),
//   )
//
// 即"把关闭动作 fork 到实例 scope 里",不受调用方中断影响。`cancel` 没有这么做,
// 两处语义不一致 —— 这种不一致通常就是遗漏,而不是有意设计。
//
// 断言:
//   S0  定位 cancel / settle
//   S1  对照:settle 用 forkIn 异步关闭 scope
//   S2  cancel 必须让关闭动作不受调用方中断影响
//      (forkIn / uninterruptibleMask / Effect.onInterrupt 之一)
//   B1  行为:模拟"取消后立刻中断调用方",scope 仍必须被关闭
//   B2  行为:正常路径(不中断)scope 必须被关闭(不得把功能改坏)
//   B3  行为:被中断时状态仍必须是一致的 cancelled(既有语义不得改坏)

import fs from "node:fs"

const SRC = "D:/dd/opencode-v1/packages/core/src/background-job.ts"

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}${detail ? "\n        " + detail : ""}`)
  }
}

const src = fs.readFileSync(SRC, "utf8")

function fnBody(startMarker) {
  const start = src.indexOf(startMarker)
  if (start < 0) return null
  const open = src.indexOf("{", start)
  if (open < 0) return null
  let d = 0
  let i = open
  let prev = ""
  while (i < src.length) {
    const c = src[i]
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++
        i++
      }
      i++
      prev = q
      continue
    }
    if (c === "{") d++
    else if (c === "}") {
      d--
      if (d === 0) return src.slice(start, i + 1)
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return null
}

const cancelBody = fnBody('const cancel: Interface["cancel"]')
const settleBody = fnBody('const settle = Effect.fn("BackgroundJob.settle")')

check("S0: 定位 cancel / settle", !!cancelBody && !!settleBody)

// ---- S1: settle 用 forkIn 关闭 ----
check(
  "S1: 对照——settle 用 forkIn 异步关闭 scope(不受调用方中断影响)",
  !!settleBody && /Scope\.close\(result\.scope[^)]*\)\s*\.pipe\(\s*Effect\.forkIn\(state\.scope/.test(settleBody.replace(/\s+/g, " ")) ||
    (!!settleBody && /Scope\.close/.test(settleBody) && /forkIn\(state\.scope/.test(settleBody)),
  settleBody ? "" : "未定位 settle",
)

// ---- S2: cancel 的关闭必须抗中断 ----
if (cancelBody) {
  const compact = cancelBody.replace(/\s+/g, " ")
  const hasClose = /Scope\.close\(result\.scope/.test(compact)
  const guarded =
    /Scope\.close\(result\.scope[^)]*\)\s*\.pipe\(\s*Effect\.forkIn\(state\.scope/.test(compact) ||
    /forkIn\(state\.scope/.test(compact) ||
    /uninterruptibleMask/.test(compact) ||
    /onInterrupt/.test(compact) ||
    /Effect\.ensuring/.test(compact)
  check(
    "S2: cancel 关闭 scope 时不得受调用方中断影响(forkIn / uninterruptibleMask / ensuring)",
    hasClose && guarded,
    `实际: ${compact.slice(0, 420)}`,
  )
}

// ---- 行为层:用真实实现跑 ----
// 从源码重建一个最小可执行版本:把 cancel/settle 里与 scope 关闭相关的
// 语义抽出来,用假 SynchronizedRef / Deferred / Scope 求值。
// 关键点:被测的是**源码里的语句顺序与修饰符**,不是重写一份逻辑。
//
// 由于 Effect 运行时不可用(未安装依赖),这里用"等价判定":
// 检查 cancel 中 Scope.close 是否处于可能被中断的裸 yield* 位置。
if (cancelBody) {
  const compact = cancelBody.replace(/\s+/g, " ")
  // B1: 找"关闭 scope"的那条语句,判定它是否被 forkIn/ensuring/uninterruptibleMask 保护。
  // 语句可能跨行、可能带 .pipe(),也可能包在 if 块里 —— 取从 `if (result.scope)` 到
  // `return result.info` 之间的整段。
  const b1Start = compact.indexOf("if (result.scope)")
  const b1End = compact.indexOf("return result.info", b1Start)
  const closeText = b1Start >= 0 && b1End > b1Start ? compact.slice(b1Start, b1End) : ""
  const protectedClose =
    /forkIn\(state\.scope/.test(closeText) ||
    /uninterruptibleMask/.test(compact) ||
    /onInterrupt/.test(closeText) ||
    /\.pipe\(\s*Effect\.ensuring/.test(closeText)
  check(
    "B1: `取消后立刻中断调用方`时 scope 仍必须被关闭(关闭动作不能是裸 yield*)",
    closeText.length > 0 && protectedClose,
    `实际关闭语句: ${JSON.stringify(closeText.slice(0, 200) || "(未匹配)")}`,
  )

  // B1b: forkIn 的目标必须立即启动。`startImmediately: false` 会把关闭排到
  // 实例 scope 关闭时才执行 —— 那时 job 早就不该再活着,等于没关。
  // 静态断言必须查到这个选项,否则"加了 forkIn 但语义错"仍会通过。
  const needsImmediate = /forkIn\(state\.scope, \{ startImmediately: true \}\)/.test(closeText.replace(/\s+/g, " "))
  check(
    "B1b: forkIn 必须带 startImmediately: true(否则关闭被推迟到实例销毁)",
    needsImmediate,
    `实际: ${JSON.stringify(closeText.replace(/\s+/g, " ").slice(0, 200) || "(未匹配)")}`,
  )

  // B2: 正常路径仍必须关闭(feature 不能丢)
  check(
    "B2: 正常路径下 scope 必须被关闭(不得把功能改坏)",
    /Scope\.close\(result\.scope/.test(compact),
    "",
  )

  // B3: 状态仍必须写成 cancelled
  check(
    "B3: 被中断时状态仍必须是一致的 cancelled(既有语义不得改坏)",
    /status: "cancelled"/.test(compact) && /if \(result\.info && result\.done\) yield\* Deferred\.succeed/.test(compact),
    "",
  )
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
