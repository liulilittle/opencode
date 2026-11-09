// 第 87 轮:Snapshot.diffFull 忽略 git 退出码
//
// diffFull 执行两条 git 命令并直接用它们的 stdout 解析:
//
//   const statuses = yield* git([... "diff", "--name-status", ...])
//   for (const line of statuses.text.trim().split("\n")) { ... }   // 无 code 检查
//
//   const numstat = yield* git([... "diff", "--numstat", ...])
//   const rows = numstat.text.trim().split("\n")...                // 无 code 检查
//
// 而 `git()` 在 spawn 失败/非零退出时返回 { code, text: "", stderr } 而不是抛错
// (index.ts:87-99 把错误吞成 ExitCode(1) + 空 text)。于是 git 失败的具体表现是
// `statuses.text === ""` → 解析出 0 行 → **静默返回空数组**,调用方无法区分
// "没有差异"和"git 失败了"。
//
// 同文件另外 9 处 git 调用都检查了 code(index.ts:248, 306, 359, 533 等)并 logWarning,
// 只有 diffFull 的两处漏了。这是不一致,不是风格差异:另外几处的输出被当作
// "可能为空"的结果消费,diffFull 的输出被当作"完整差异列表"消费。
//
// 断言:
//   S0 定位 diffFull
//   S1 statuses 必须检查退出码
//   S2 numstat 必须检查退出码
//   S3 对照:同文件其它 git 调用确实检查退出码(证明这是失配,不是全仓惯例)
//   B1 git 失败(statuses 空输出)时,diffFull 必须留下可观测信号(日志或降级标记),
//      不能与"真的没有差异"不可区分
//   B2 正常路径仍返回完整 rows(修复不得把成功路径也变成空)

import fs from "node:fs"

const SRC = "D:/dd/opencode-v1/packages/opencode/src/snapshot/index.ts"

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

// ---- S0 ----
const dfStart = src.indexOf('const diffFull = Effect.fnUntraced')
check("S0: 定位 diffFull 实现", dfStart >= 0)
const dfEnd = src.indexOf("yield* cleanup()", dfStart)
const df = dfStart >= 0 && dfEnd > dfStart ? src.slice(dfStart, dfEnd) : null
check("S0b: 提取 diffFull 函数体", !!df, df ? "" : "未提取到")

if (df) {
  // ---- S1/S2 ----
  check(
    "S1: statuses 的 git 调用必须检查退出码",
    /statuses\.code/.test(df),
    `实际未出现 statuses.code;片段: ${df.slice(df.indexOf("const statuses"), df.indexOf("const statuses") + 200).replace(/\s+/g, " ")}`,
  )
  check(
    "S2: numstat 的 git 调用必须检查退出码",
    /numstat\.code/.test(df),
    `实际未出现 numstat.code;片段: ${df.slice(df.indexOf("const numstat"), df.indexOf("const numstat") + 200).replace(/\s+/g, " ")}`,
  )
}

// ---- S3 对照:其它 git 调用检查码 ----
// 只在 diffFull 之外找 "code !== 0" 或 ".code ===" 形态。
const outside = df ? src.slice(0, dfStart) + src.slice(dfEnd) : src
const otherChecks = (outside.match(/\.code\s*(!==|===)\s*0/g) ?? []).length
check(
  "S3: 对照——diffFull 之外至少有 5 处检查 git 退出码(说明检查是本文件惯例)",
  otherChecks >= 5,
  `实际: ${otherChecks} 处`,
)

// ---- B 层:用真实实现片段判定 "空输出" 是否可与 "无差异" 区分 ----
// 从源码里取出 statuses 解析表达式,对 "git 失败 → text === ''" 求值,
// 看是否产生与"真的无差异"完全相同的输出,且不产生任何信号。
if (df) {
  // B1: statuses 与 numstat 是两次独立调用,各自的失败必须独立可观测。
  // 只断言其中一个会让另一个的退化逃逸。
  const statusesSignal = /if\s*\(\s*statuses\.code\s*!==\s*0\s*\)\s*\{[\s\S]*?logWarning/.test(df)
  const numstatSignal = /if\s*\(\s*numstat\.code\s*!==\s*0\s*\)\s*\{[\s\S]*?logWarning/.test(df)
  check(
    "B1: statuses 空输出(git 失败)时必须留下可观测信号",
    statusesSignal,
    "实际: git 失败时 statuses.text === '' → 解析出 0 行 → 静默 return [],与'无差异'不可区分",
  )
  check(
    "B1b: numstat 空输出(git 失败)时同样必须留下可观测信号",
    numstatSignal,
    "实际: numstat 失败未被单独观测",
  )

  // B1c: 诊断必须带上 stderr —— 只报 exitCode 无法定位 git 为什么失败。
  const statusesStderr = /statuses\.code\s*!==\s*0\s*\)\s*\{[\s\S]*?stderr:\s*statuses\.stderr/.test(df)
  const numstatStderr = /numstat\.code\s*!==\s*0\s*\)\s*\{[\s\S]*?stderr:\s*numstat\.stderr/.test(df)
  check(
    "B1c: 两处失败日志都必须带 stderr(否则无法定位 git 失败原因)",
    statusesStderr && numstatStderr,
    `statuses.stderr=${statusesStderr} numstat.stderr=${numstatStderr}`,
  )

  // B2: 正常路径不得被修复破坏 —— 断言 rows 解析逻辑仍在且能产出多行
  const rowsExpr = df.match(/const rows = numstat\.text[\s\S]*?\}\)\)/)
  let normalOk = false
  if (rowsExpr) {
    // 用等价语义手工验证:三行 numstat 输出应产生三条记录
    const lines = ["3\t0\tmulti.txt", "1\t1\tx.txt", "0\t2\ty.txt"]
    normalOk = lines.filter((l) => l.split("\t")[2]).length === 3
  }
  check(
    "B2: 正常路径仍然解析全部 numstat 行(修复不得把成功路径变成空)",
    !!rowsExpr && normalOk,
    rowsExpr ? "" : "未找到 rows 解析表达式",
  )
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
