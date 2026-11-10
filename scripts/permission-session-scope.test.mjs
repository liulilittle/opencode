// 第 90 轮:Permission 的 approved 规则跨会话泄漏
//
// 文档 `packages/web/src/content/docs/permissions.mdx:196` 规定:
//
//   `always` — approve future requests matching the suggested patterns
//   **(for the rest of the current OpenCode session)**
//
// 当前实现的状态:
//
//   interface State {
//     pending: Map<PermissionV1.ID, PendingEntry>
//     approved: PermissionV1.Rule[]      // <- 全局数组,不区分 session
//   }
//
// `reply()` 的 always 分支:
//
//   for (const pattern of existing.info.always) {
//     approved.push({ permission: existing.info.permission, pattern, action: "allow" })
//   }
//
// push 里**没有 sessionID**。`ask()` 则无条件把整个 `approved` 传给 evaluate:
//
//   const rule = evaluate(request.permission, pattern, ruleset, approved)
//
// 于是 A 会话里点过的 "always" 会为 B 会话直接放行,与文档的
// "for the rest of the current OpenCode session" 直接矛盾。
//
// 旧实现(2fc06c5a17^ 删除前的 legacy permission 模块)是 per-session 的:
//
//   approved: new Map<SessionID, Map<string, boolean>>()
//   const approvedForSession = approved.get(input.sessionID)
//   if (approvedForSession && covered(keys, approvedForSession)) return
//
// 说明"按会话隔离"是原始设计,不是新增需求。
//
// 断言:
//   S0 定位 approved 的类型声明
//   S1 approved 必须携带会话维度(不能是裸 Rule[])
//   S2 reply 的 push 必须写入会话标识
//   S3 ask 的 evaluate 只能看到**本会话**的 approved
//   B1 行为:会话 A 批准后,会话 A 的同类请求放行(不得把功能改坏)
//   B2 行为:会话 A 批准后,会话 B 的同类请求**仍然 ask**(核心断言)
//   B3 对照:文档确实写了 "for the rest of the current OpenCode session"

import fs from "node:fs"

const SRC = "D:/dd/opencode-v1/packages/opencode/src/permission/index.ts"
const DOC = "D:/dd/opencode-v1/packages/web/src/content/docs/permissions.mdx"

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
const doc = fs.readFileSync(DOC, "utf8")

// ---- S0: approved 的类型声明 ----
const ifaceStart = src.indexOf("interface State {")
const ifaceEnd = src.indexOf("}", ifaceStart)
const iface = ifaceStart >= 0 ? src.slice(ifaceStart, ifaceEnd + 1) : null
check("S0: 定位 State 接口", !!iface)
if (iface) {
  const bare = /approved:\s*PermissionV1\.Rule\[\]/.test(iface)
  check(
    "S1: approved 必须携带会话维度(不能是裸 Rule[])",
    !bare,
    bare ? `实际: ${iface.replace(/\s+/g, " ")}` : "",
  )
}

// ---- S2: 写入 approved 时必须落到该会话的桶里 ----
// 不绑定具体写法(set/push/get),而是断言:写入处必须出现会话键。
const alwaysStart = src.indexOf("for (const pattern of existing.info.always)")
check("S2a: 定位 always 分支", alwaysStart >= 0)
if (alwaysStart >= 0) {
  const block = src.slice(alwaysStart, src.indexOf("\n      }", alwaysStart) + 8)
  check(
    "S2: always 分支写入 approved 时必须带 sessionID",
    /sessionID/.test(block),
    `实际: ${block.replace(/\s+/g, " ").slice(0, 240)}`,
  )
}

// ---- S3: ask 传给 evaluate 的 approved 必须是本会话的 ----
const askStart = src.indexOf('const ask = Effect.fn("Permission.ask")')
const askEnd = src.indexOf('const reply = Effect.fn("Permission.reply")', askStart)
const askBody = askStart >= 0 && askEnd > askStart ? src.slice(askStart, askEnd) : null
check("S3a: 提取 ask 函数体", !!askBody)
if (askBody) {
  const evalCall = askBody.match(/evaluate\(([^)]*)\)/)
  const args = evalCall ? evalCall[1] : ""
  // approved 变为 Map<sessionID, Rule[]> 后,传给 evaluate 的必须是**本会话桶**
  // (形如 approved.get(sessionID) 或先取到局部变量),不能是裸 Map/裸数组标识符。
  const passesBucket = /\.get\(\s*[^)]*sessionID/.test(args) || /\.get\(\s*[^)]*request\.sessionID/.test(args)
  const passesScopedVar = /\b(scoped|sessionRules|sessionApproved)\b/.test(args) && !/\bapproved\s*$/.test(args.trim())
  check(
    "S3: ask 的 evaluate 只能看到本会话的 approved",
    passesBucket || passesScopedVar,
    `实际 evaluate 参数: ${args.replace(/\s+/g, " ")}`,
  )
}

// ---- B 层:模拟当前状态结构,验证跨会话是否泄漏 ----
// 用真实源码里的 evaluate 实现 + 真实 Wildcard.match 求值。
const wcSrc = fs.readFileSync("D:/dd/opencode-v1/packages/core/src/util/wildcard.ts", "utf8")
// 用花括号配对提取函数体,避免 indexOf("\n}") 命中嵌套块而过早/过晚截断。
function extractBlock(text, startMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) return null
  const open = text.indexOf("{", start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

let evaluate = null
try {
  const body = extractBlock(src, "export function evaluate")
    .replace("export function evaluate", "function evaluate")
    .replace(
      /function evaluate\([^)]*\)\s*:\s*PermissionV1\.Rule\s*\{/,
      "function evaluate(permission, pattern, ...rulesets) {",
    )
  const matchBody = extractBlock(wcSrc, "export function match")
    .replace("export function match", "function match")
    .replace(/function match\([^)]*\)\s*\{/, "function match(input, pattern) {")
  const wc = new Function(`${matchBody}\nreturn { match }`)()
  evaluate = new Function("Wildcard", `${body}\nreturn evaluate`)(wc)
  check("B0: 能从源码构造 evaluate + Wildcard", true)
} catch (e) {
  check("B0: 能从源码构造 evaluate + Wildcard", false, e.message)
}

if (evaluate) {
  // B1: 同会话批准后放行(无论实现如何,这个语义必须保持)
  const sameSession = evaluate("bash", "ls", [], [{ permission: "bash", pattern: "ls", action: "allow" }])
  check(
    "B1: 本会话批准后同类请求必须 allow(不得把功能改坏)",
    sameSession.action === "allow",
    `实际: ${sameSession.action}`,
  )

  // B2 的核心不是 evaluate 本身(它没有会话概念),而是"ask 是否把别的会话的
  // approved 也传进来"。这一点由 S1/S3 结构断言覆盖。
  // 这里额外断言:approve 的存储必须能按会话区分 —— 用类型声明判定。
  const sessionScoped = !!iface && !/approved:\s*PermissionV1\.Rule\[\]\s*$/.test(iface.trim().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("approved")).join(""))
  check(
    "B2: approve 存储必须能按会话区分(否则 B 会话必然继承 A 会话的批准)",
    sessionScoped,
    "实际: approved: PermissionV1.Rule[] —— 无会话维度,必然跨会话生效",
  )
}

// ---- B3: 文档依据 ----
check(
  "B3: 对照——文档规定 always 只在当前会话内有效",
  /for the rest of the current OpenCode session/.test(doc),
  "未在 permissions.mdx 找到该表述",
)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
