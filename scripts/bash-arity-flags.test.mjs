// 第 92 轮重写:第 91 轮的这套断言方向本身是错的
//
// 第 91 轮把"flag 不得出现在授权模式里"当成正确目标,于是修成"在第一个
// flag 处截断",结果把授权放大成整个程序(`git --version` -> `git *`)。
// 见 scripts/bash-arity-no-widening.test.mjs 的 P1 不变式。
//
// 正确的目标不是"模式里没有 flag",而是**flag 的取值必须被固定**:
//   `pip --index-url http://corp install pkg` -> `pip --index-url http://corp`
// 这样 `pip --index-url http://evil ...` 不匹配,会重新询问。
//
// 本套件保留原意图(不允许"任意 flag 取值"被静默放行),但改为断言
// "取值被固化",并额外锁住"不得放大到整个程序"。
//
// 断言:
//   S0  从源码构造 ARITY + prefix(含辅助函数)
//   S1  字典规则:flags 不计数(对照)
//   S2  prefix 用位置参数查字典、按位置参数定位原始 token 边界
//   B1  带值 flag:取值必须出现在模式中(被固定)
//   B2  bool flag:必须出现在模式中(不得被丢弃后放大)
//   B3  无 flag 命令语义不变
//   B4  `python -c "<code>"`:`-c` 与代码都必须被固定
//   B5  模式不得退化成裸程序名(除非原实现也如此)
//   P1  广度不变式(与 no-widening 套件重复但代价低,保留为交叉校验)

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

function balancedFrom(text, marker) {
  const start = text.indexOf(marker)
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

function functionFrom(text, marker) {
  const start = text.indexOf(marker)
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

const ARITY = new Function("return " + balancedFrom(src, "const ARITY: Record<string, number> = "))()

let prefix = null
try {
  let helpers = ""
  for (const name of ["positionalCount", "leadingPositionals"]) {
    const fn = functionFrom(src, "function " + name)
    if (!fn) continue
    helpers +=
      fn
        .replace(/\(tokens: string\[\],\s*count: number\)\s*:\s*number/, "(tokens, count)")
        .replace(/\(tokens: string\[\]\)\s*:\s*string\[\]/, "(tokens)")
        .replace(/tokens\[i\]!/g, "tokens[i]") + "\n"
  }
  const body = functionFrom(src, "export function prefix")
    .replace("export function prefix", "function prefix")
    .replace(/\(tokens: string\[\]\)/, "(tokens)")
    .replace(/tokens\[i\]!/g, "tokens[i]")
  prefix = new Function("ARITY", `${helpers}${body}\nreturn prefix`)(ARITY)
  check("S0: 从源码构造 ARITY + prefix", true)
} catch (e) {
  check("S0: 从源码构造 ARITY + prefix", false, e.message)
}

check(
  "S1: 对照——字典生成规则明确要求 flags 不计数",
  /Flags NEVER count as tokens/.test(src),
  "未在源码注释中找到该规则",
)

if (prefix) {
  const body = functionFrom(src, "export function prefix")
  const helperBody = functionFrom(src, "function positionalCount") ?? ""
  check(
    "S2: prefix 按位置参数查字典,并按位置参数定位原始 token 边界",
    /filter\(/.test(body) && /positionalCount\(/.test(body) && /startsWith\(\s*["']-["']\s*\)/.test(helperBody),
    `prefix: ${body.replace(/\s+/g, " ").slice(0, 220)}`,
  )

  const got = (t) => prefix(t).join(" ")

  // ---- B1: 带值 flag 的取值必须被固定 ----
  const pip = got(["pip", "--index-url", "http://corp.example", "install", "pkg"])
  check(
    "B1: 带值 flag 的取值必须被固定(pip --index-url <host> 保留 host)",
    pip === "pip --index-url http://corp.example",
    `实际: ${JSON.stringify(pip + " *")}`,
  )

  // ---- B2: bool flag 必须保留,不得丢弃后放大 ----
  check(
    "B2: bool flag 必须保留在模式中(npm -v 不得退化成 npm)",
    got(["npm", "-v"]) === "npm -v",
    `实际: ${JSON.stringify(got(["npm", "-v"]) + " *")}`,
  )

  // ---- B3: 无 flag 命令语义不变 ----
  // 期望值对齐原实现(`ls` arity=1,`ls -la` 在原实现也切成 `ls`)。
  // 空数组单独用长度断言,避免把 [] 和 [""] 混为一谈。
  const plain = [
    [["git", "checkout", "main"], "git checkout"],
    [["docker", "compose", "up", "-d"], "docker compose up"],
    [["npm", "run", "dev"], "npm run dev"],
    [["ls", "-la"], "ls"],
    [["touch", "foo.txt"], "touch"],
  ]
  const badPlain = plain.filter(([t, want]) => got(t) !== want)
  check(
    "B3: 无 flag / 尾部 flag 命令语义不变",
    badPlain.length === 0 && prefix([]).length === 0,
    [...badPlain.map(([t, w]) => `${t.join(" ")} -> ${got(t)} (want ${w})`), prefix([]).length !== 0 ? "empty -> " + JSON.stringify(prefix([])) : ""]
      .filter(Boolean)
      .join(" ; "),
  )

  // ---- B4: -c 与代码都必须被固定 ----
  const py = got(["python", "-c", "import os;os.system('evil')"])
  check(
    "B4: python -c <code> 必须把 -c 与代码一起固定",
    py === "python -c import os;os.system('evil')",
    `实际: ${JSON.stringify(py + " *")}`,
  )

  // ---- B5: 不得退化成裸程序名 ----
  const bare = [
    [["git", "--version"], "git"],
    [["docker", "--version"], "docker"],
    [["terraform", "-version"], "terraform"],
  ]
  const widened = bare.filter(([t, merely]) => got(t) === merely)
  check(
    "B5: 带 flag 的命令不得退化成裸程序名(授权放大)",
    widened.length === 0,
    widened.map(([t]) => `${t.join(" ")} -> ${got(t)} *`).join(" ; "),
  )

  // ---- P1: 广度不变式 ----
  function originalPrefix(tokens) {
    for (let len = tokens.length; len > 0; len--) {
      const p = tokens.slice(0, len).join(" ")
      const arity = ARITY[p]
      if (arity !== undefined) return tokens.slice(0, arity)
    }
    if (tokens.length === 0) return []
    return tokens.slice(0, 1)
  }

  const corpus = [
    ["git", "--version"],
    ["git", "-C", "/repo", "status"],
    ["npm", "-v"],
    ["npm", "install"],
    ["pip", "--index-url", "http://corp", "install", "pkg"],
    ["python", "-c", "import os"],
    ["python", "script.py"],
    ["docker", "--version"],
    ["docker", "compose", "up", "-d"],
    ["kubectl", "--kubeconfig", "/p", "apply", "-f", "x"],
    ["cargo", "--manifest-path", "/e/Cargo.toml", "run"],
    ["ls", "-la"],
    ["echo", "hello"],
    ["aws", "s3", "ls", "b"],
    ["unknown", "cmd"],
    [],
  ]
  const viol = []
  for (const tokens of corpus) {
    const next = prefix(tokens)
    const prev = originalPrefix(tokens)
    const real = next.every((t, i) => t === tokens[i])
    if (!real || next.length < prev.length) {
      viol.push(`${JSON.stringify(tokens)} -> ${JSON.stringify(next.join(" "))} (原 ${JSON.stringify(prev.join(" "))})`)
    }
  }
  check("P1: 新前缀不得比原实现更宽且必须是原始 token 真前缀", viol.length === 0, viol.join("\n        "))
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
