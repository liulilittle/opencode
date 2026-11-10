// 第 93 轮:bash 参数里的 ~user 路径绕过 external_directory 检查
//
// `collect()` 对 FILES 类命令(cat/cp/rm/mv/mkdir/touch/chmod/chown 等)会把每个
// 参数解析成绝对路径,与实例根目录比较,在根外的加入 scan.dirs,随后
// `ask()` 用这些 dirs 触发 external_directory 权限询问。
//
// 解析链(shell.ts:369-376, bash 分支):
//
//   const argPath = ... (arg, cwd, ps, shell) => {
//     const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
//     const file = text && prefix(text)
//     if (!file || dynamic(file, ps)) return
//     ...
//     return yield* resolvePath(next, cwd, shell)
//   }
//
// `home()` 只处理 `~` 与 `~/`(`~\\`):
//
//   function home(text: string) {
//     if (text === "~") return os.homedir()
//     if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
//     return text
//   }
//
// `~user/...` 这种"其它用户家目录"的形式原样返回。它不含 `$`,所以
// `dynamic()` 不会拦它:
//
//   function dynamic(text: string, ps: boolean) {
//     ...
//     if (ps) return /\$(?!env:)/i.test(text)
//     return text.includes("$")
//   }
//
// 于是 `~root/.ssh/id_rsa` 被 `resolvePath(cwd, ...)` 解析成
// `<cwd>/~root/.ssh/id_rsa` —— **落在实例根目录内** → containsPath 为真 →
// 不加入 scan.dirs → **不触发 external_directory 询问**。
//
// 但 bash 真正执行时会把它展开成 `/root/.ssh/id_rsa`。权限判定看到的是
// "内部路径",实际访问的是根目录外的文件。这是**权限绕过**。
//
// 断言:
//   S0  定位 home / dynamic / resolvePath / argPath
//   S1  home 只处理 `~` / `~/`,不处理 `~user/`(记录现状)
//   S2  dynamic 不会因为它含 `~` 而拦截(记录现状)
//   B1  `~root/.ssh/id_rsa` 不得被当成 cwd 下的相对路径
//      —— 即必须被判为"无法安全确定"或展开成真实路径,而不是
//      静默 `path.resolve(cwd, "~root/...")`
//   B2  对照:`~/` 形式必须仍然正确展开(不得把功能改坏)
//   B3  对照:`$HOME/...` 在 bash 下必须仍然被 dynamic 拦下(不得把功能改坏)
//   B4  `~otheruser` 同样不得被当成内部相对路径

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SRC = "D:/dd/opencode-v1/packages/opencode/src/tool/shell.ts"

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

// 大括号配对提取函数体。必须跳过字符串与正则字面量,否则
// `/\$(?!env:)/i` 里的 `{` 会破坏计数(`dynamic()` 正是这种情况)。
function fnBody(name) {
  const start = src.indexOf("function " + name)
  if (start < 0) return null
  const open = src.indexOf("{", start)
  if (open < 0) return null
  let d = 0
  let i = open
  let prev = ""
  while (i < src.length) {
    const c = src[i]
    // 单行注释
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i)
      i = nl < 0 ? src.length : nl
      continue
    }
    // 正则字面量:粗略判定 —— 前一个非空白是 ( , = : ! & | ? { } ; return 等
    if (c === "/" && /[=(:,!&|?{};\n]/.test(prev) && src[i + 1] !== "/" && src[i + 1] !== "*") {
      i++
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") i++
        i++
      }
      i++
      prev = "/"
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++
        i++
      }
      i++
      prev = quote
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

const homeSrc = fnBody("home")
const dynamicSrc = fnBody("dynamic")
const unquoteSrc = fnBody("unquote")

check("S0: 定位 home / dynamic / unquote", !!homeSrc && !!dynamicSrc && !!unquoteSrc)

if (homeSrc && dynamicSrc && unquoteSrc) {
  const home = new Function(
    "os",
    "path",
    `${homeSrc.replace(/\(text: string\)/, "(text)")}\nreturn home`,
  )(os, path)
  const dynamic = new Function(
    `${dynamicSrc.replace(/\(text: string, ps: boolean\)/, "(text, ps)")}\nreturn dynamic`,
  )()
  const unquote = new Function(`${unquoteSrc.replace(/\(text: string\)/, "(text)")}\nreturn unquote`)()

  // ---- S1: home 对 `~user` 必须返回 undefined(无法安全解析) ----
  check(
    "S1: home 对 `~user/...` 返回 undefined(不猜其它用户家目录),对 `~/` 仍正常展开",
    home("~") === os.homedir() &&
      home("~/x") === path.join(os.homedir(), "x") &&
      home("~root/x") === undefined,
    `home("~root/x") = ${JSON.stringify(home("~root/x"))}`,
  )

  // ---- S2: dynamic 只看 $ ----
  check(
    "S2: 对照——dynamic 不因 ~ 而拦截",
    dynamic("~root/x", false) === false,
    `dynamic("~root/x", false) = ${dynamic("~root/x", false)}`,
  )

  // 模拟 argPath 的 bash 分支:ps=false -> home(unquote(arg)) -> prefix() -> dynamic() -> resolvePath
  function bashResolve(arg, cwd) {
    const text = home(unquote(arg))
    // prefix() 截断通配符
    const m = /[?*[]/.exec(text)
    const file = !m ? text : m.index === 0 ? undefined : text.slice(0, m.index)
    if (!file || dynamic(file, false)) return undefined
    return path.resolve(cwd, file)
  }

  const cwd = process.platform === "win32" ? "C:\\repo" : "/repo"

  // ---- B1: ~root 不得被解析成 cwd 下的相对路径 ----
  const b1 = bashResolve("~root/.ssh/id_rsa", cwd)
  const wrong = b1 !== undefined && b1.startsWith(cwd)
  check(
    "B1: `~root/...` 不得被当成实例内的相对路径(否则权限检查认为内部,shell 实际访问 /root)",
    !wrong,
    `实际解析为: ${JSON.stringify(b1)}(落在 cwd 内 = 绕过)`,
  )

  // ---- B2: ~/ 必须仍然正确展开 ----
  const b2 = bashResolve("~/projects/file.txt", cwd)
  check(
    "B2: `~/...` 必须仍然正确展开为家目录下路径",
    b2 === path.resolve(os.homedir(), "projects/file.txt"),
    `实际: ${JSON.stringify(b2)}`,
  )

  // ---- B3: bash 下 $HOME 必须仍被拦截 ----
  const b3 = bashResolve("$HOME/.ssh/id_rsa", cwd)
  check(
    "B3: bash 下 `$HOME/...` 必须仍被视为无法确定(dynamic 拦截)",
    b3 === undefined,
    `实际: ${JSON.stringify(b3)}`,
  )

  // ---- B4: ~otheruser 同样 ----
  const b4 = bashResolve("~otheruser/file", cwd)
  const wrong4 = b4 !== undefined && b4.startsWith(cwd)
  check(
    "B4: `~otheruser/...` 同样不得被当成实例内的相对路径",
    !wrong4,
    `实际解析为: ${JSON.stringify(b4)}`,
  )
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
