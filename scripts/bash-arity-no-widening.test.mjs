// 第 92 轮:纠正第 91 轮引入的授权放大回归
//
// 第 91 轮把 prefix() 改成"在第一个 flag 处截断"(leadingPositionals),
// 目的是阻止 flag 的**取值**被通配符吞掉:
//   `pip --index-url http://corp install pkg` 不应授权成 `pip --index-url *`。
//
// 但它把权限放大成了最坏的形式 —— 整个程序:
//   `git --version`                 -> `git *`            (修复前是 `git --version *`)
//   `npm -v`                        -> `npm *`            (修复前是 `npm -v *`)
//   `pip --index-url X install pkg` -> `pip *`            (修复前是 `pip --index-url *`)
//   `docker --version`              -> `docker *`
//
// `git *` 匹配任意 git 命令,`pip *` 匹配任意 pip 命令 —— 比原来的
// `git --version *` / `pip --index-url *` 宽得多。用户批准 `git --version`,
// 拿到的是"允许所有 git"。
//
// 正确做法:arity 的数量按**位置参数**计算(flag 不计数,符合字典注释),
// 但输出应当切在**原始 token** 上,按"已消费的位置参数个数"定位下标。
// 这样 flag 及其取值都被固定在模式里:
//   `pip --index-url http://corp install pkg` -> `pip --index-url http://corp`
//   `git -C /repo status`                    -> `git -C /repo`
//   `git --version`                          -> `git --version`(位置参数不足,退回全部)
//   `docker compose up -d`                   -> `docker compose up`
//
// 不变式(核心断言):新前缀的**广度永远不超过**原实现的 `tokens.slice(0, arity)`。
// 因为 flag 计入 token 但不计入位置参数,达到同样多数量的位置参数必然需要
// 不少于 arity 个 token,所以新前缀长度 >= arity,即更具体、更窄。
//
// 断言:
//   S0  从源码构造 prefix
//   B1  `git --version` 必须保留 flag,不得退化成 `git`
//   B2  带值 flag 必须连同取值一起固定(`pip --index-url <host>` 保留 host)
//   B3  flag 在中间时任然要固定(`git -C /repo status` 保留 /repo)
//   B4  子命令语义不变(`docker compose up -d` -> `docker compose up`)
//   B5  无 flag 命令不变(`git checkout main` -> `git checkout`)
//   P1  属性:对一批真实命令,新前缀长度 >= 原实现的 arity,且是原始 token 的前缀

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

// 把 prefix 及其可能用到的辅助函数一起从源码取出后编译。
// 用到的辅助函数全部按名字尝试提取,提取不到的保持未定义 —— 这样
// 若实现改了辅助函数名,B0 会失败而不是静默用测试里的替身。
function buildPrefix() {
  const helpers = ["leadingPositionals", "positionalCount", "convertPositionals"]
  let src2 = ""
  for (const name of helpers) {
    const fn = functionFrom(src, "function " + name)
    if (fn) {
      src2 +=
        fn
          .replace(/\(tokens: string\[\],\s*count: number\)\s*:\s*number/, "(tokens, count)")
          .replace(/\(tokens: string\[\]\)\s*:\s*string\[\]/, "(tokens)")
          .replace(/\(tokens: string\[\]\)\s*:\s*number/, "(tokens)")
          .replace(/const out: string\[\]\s*=/, "const out =")
          .replace(/tokens\[i\]!/g, "tokens[i]") + "\n"
    }
  }
  const body = functionFrom(src, "export function prefix")
  if (!body) throw new Error("prefix not found")
  const clean = body
    .replace("export function prefix", "function prefix")
    .replace(/\(tokens: string\[\]\)/, "(tokens)")
    .replace(/tokens\[i\]!/g, "tokens[i]")
  return new Function("ARITY", `${src2}${clean}\nreturn prefix`)(ARITY)
}

let prefix = null
try {
  prefix = buildPrefix()
  check("S0: 从源码构造 ARITY + prefix", true)
} catch (e) {
  check("S0: 从源码构造 ARITY + prefix", false, e.message)
}

if (prefix) {
  const got = (t) => prefix(t).join(" ")

  // ---- B1: 不得把带 flag 的命令退化成整个程序 ----
  check(
    "B1: git --version 必须保留 flag(不得退化成 git)",
    got(["git", "--version"]) === "git --version",
    `实际: ${JSON.stringify(got(["git", "--version"]) + " *")}`,
  )

  // ---- B2: 带值 flag 的取值必须固定 ----
  const pip = got(["pip", "--index-url", "http://corp.example", "install", "pkg"])
  check(
    "B2: 带值 flag 必须连同取值一起固定",
    pip === "pip --index-url http://corp.example",
    `实际: ${JSON.stringify(pip + " *")}`,
  )

  // ---- B3: flag 在中间时也要固定其后紧邻的取值 ----
  const gitC = got(["git", "-C", "/repo", "status"])
  check(
    "B3: flag 在中间时同样固定取值(git -C /repo status 保留 /repo)",
    gitC === "git -C /repo",
    `实际: ${JSON.stringify(gitC + " *")}`,
  )

  // ---- B4: 子命令语义不变 ----
  check(
    "B4: docker compose up -d 仍为 docker compose up",
    got(["docker", "compose", "up", "-d"]) === "docker compose up",
    `实际: ${JSON.stringify(got(["docker", "compose", "up", "-d"]) + " *")}`,
  )

  // ---- B5: 无 flag 命令保持不变 ----
  const plain = [
    [["git", "checkout", "main"], "git checkout"],
    [["git", "status"], "git status"],
    [["npm", "run", "dev"], "npm run dev"],
    [["ls", "-la"], "ls"],
    [["touch", "foo.txt"], "touch"],
    [["aws", "s3", "ls", "bucket"], "aws s3 ls"],
  ]
  const bad = plain.filter(([t, want]) => got(t) !== want)
  check(
    "B5: 无 flag 命令语义不变",
    bad.length === 0,
    bad.map(([t, w]) => `${t.join(" ")} -> ${got(t)} (want ${w})`).join(" ; "),
  )

  // ---- P1: 广度不变式 —— 新前缀不得比原实现的 slice(0, arity) 更宽 ----
  // 原实现:在原始 token 上做最长前缀匹配,然后 tokens.slice(0, arity)。
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
    ["git", "--help"],
    ["git", "-C", "/repo", "status"],
    ["git", "-c", "core.pager=cat", "log"],
    ["npm", "-v"],
    ["npm", "install"],
    ["npm", "run", "dev"],
    ["npm", "--prefix", "/x", "install", "evil"],
    ["pip", "--index-url", "http://corp", "install", "pkg"],
    ["pip", "install", "requests"],
    ["python", "-c", "import os"],
    ["python", "script.py"],
    ["docker", "--version"],
    ["docker", "-H", "tcp://host", "run", "img"],
    ["docker", "compose", "up", "-d"],
    ["kubectl", "--kubeconfig", "/p", "apply", "-f", "x"],
    ["kubectl", "get", "pods"],
    ["terraform", "-chdir=/e", "apply"],
    ["cargo", "--manifest-path", "/e/Cargo.toml", "run"],
    ["ls", "-la"],
    ["echo", "hello", "world"],
    ["touch", "foo.txt"],
    ["aws", "s3", "ls", "b"],
    ["unknown", "cmd", "sub"],
    ["single"],
    [],
  ]

  const violations = []
  for (const tokens of corpus) {
    const next = prefix(tokens)
    const prev = originalPrefix(tokens)
    // 新前缀必须是原始 token 的真实前缀
    const isRealPrefix = next.every((tok, i) => tok === tokens[i])
    // 新前缀长度不得小于原实现(更短 = 更宽)
    const notWider = next.length >= prev.length
    if (!isRealPrefix || !notWider) {
      violations.push(
        `${JSON.stringify(tokens)} -> ${JSON.stringify(next.join(" "))} (原 ${JSON.stringify(prev.join(" "))}, realPrefix=${isRealPrefix})`,
      )
    }
  }
  check(
    "P1: 新前缀不得比原实现更宽(且必须是原始 token 的真前缀)",
    violations.length === 0,
    violations.join("\n        "),
  )
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
