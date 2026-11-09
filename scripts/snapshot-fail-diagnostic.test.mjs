// 第 88 轮:Snapshot.diffFull 的 fail() 丢弃全部诊断
//
// diffFull 的批量读取路径(cat-file --batch)有五个失败判定点:
//
//   1. batch.exitCode !== 0            -> logInfo(...stderr, refs)     有日志
//   2. 头部被截断(end >= out.length)  -> return fail("...truncated header...")
//   3. 头部格式不对(!match)           -> return fail("...unexpected header...", { head })
//   4. 内容被截断(size 不合法)        -> return fail("...truncated content...", { head })
//   5. 尾部有多余数据(i !== out.length) -> return fail("...trailing data...")
//
// fail 的定义(index.ts:623-625):
//
//   const fail = (msg: string, extra?: Record<string, string>) => {
//     return undefined
//   }
//
// 它接收 msg 与 extra,函数体直接返回 undefined —— 四条诊断信息(其中两条还带了
// 出错的 head 内容)**全部丢弃**。调用方在 index.ts:745 用
//
//   const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
//
// 兜底,所以功能不出错(会退回逐文件 git show),但**没有任何痕迹说明批量路径为什么退化**。
// 现场表现是"快照 diff 突然变慢 N 倍",日志里一个字都没有。
//
// 这不是风格问题:同函数上方第 1 个失败点(batch.exitCode)是**有 logInfo 的**,
// 说明作者本意就是要留痕,只是 fail 的实现在重构中被掏空了。而
// `@tsconfig/bun` 的 `noUnusedParameters: false` 让编译器不会报"参数未使用"。
//
// 断言:
//   S0  定位 fail 定义
//   S1  fail 必须实际使用 msg 参数(不能恒返回 undefined)
//   S2  fail 必须实际使用 extra 参数(调用方传了出错的 head)
//   S3  对照:同一 load() 里 batch.exitCode 失败路径确实有日志(证明留痕是本意)
//   S4  fail 的四个调用点必须都在
//   B1  用真实源码提取的 fail 函数体求值:传入 msg 后必须产生可观测输出
//   B2  正常路径(map 构建)不受影响 —— 修复不得改变返回类型语义

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

// ---- S0: 定位 fail 定义 ----
const failStart = src.indexOf("const fail = (msg: string")
check("S0: 定位 fail 定义", failStart >= 0)

let failBody = null
if (failStart >= 0) {
  // 函数体到下一个空行后的 "const map" 之前
  const anchor = src.indexOf("const map = new Map<string, { before: string; after: string }>()", failStart)
  if (anchor > failStart) failBody = src.slice(failStart, anchor)
  check("S0b: 提取 fail 函数体", !!failBody, failBody ? "" : "未能切出函数体")
}

if (failBody) {
  const compact = failBody.replace(/\s+/g, " ")

  // ---- S1: 必须使用 msg ----
  // 判定:函数体里 msg 至少出现在一个非签名位置。签名本身含 "msg: string",
  // 因此要在签名之后的部分查找。
  const sigEnd = compact.indexOf("=> {")
  const bodyOnly = sigEnd >= 0 ? compact.slice(sigEnd + 4) : compact
  check(
    "S1: fail 必须在函数体内使用 msg(不能恒返回 undefined)",
    /\bmsg\b/.test(bodyOnly),
    `实际函数体: ${bodyOnly.slice(0, 160)}`,
  )
  check(
    "S2: fail 必须在函数体内使用 extra(调用方传了出错的 head)",
    /\bextra\b/.test(bodyOnly),
    `实际函数体: ${bodyOnly.slice(0, 160)}`,
  )
}

// ---- S4: 对照 —— 同一 load() 里已存在的日志 ----
const loadStart = src.indexOf("const load = Effect.fnUntraced")
const loadEnd = src.indexOf("const result: FileDiff[] = []", loadStart)
const loadBody = loadStart >= 0 && loadEnd > loadStart ? src.slice(loadStart, loadEnd) : null
check(
  "S4: 对照——load() 里 batch.exitCode 失败路径确实有日志(证明留痕是本意)",
  !!loadBody && /batch\.exitCode !== 0[\s\S]{0,300}log(Info|Warning|Error)/.test(loadBody),
  "",
)

// ---- S5: 四个 fail 调用点必须都在,且必须 yield* ----
// fail 现在返回 Effect;漏掉 yield* 会导致日志永远不执行(Effect 惰性),
// 等于把"丢弃诊断"换成"诊断写了但从不跑"。两者同样不可接受。
const failCalls = (src.match(/return yield\* fail\(/g) ?? []).length
const bareFailCalls = (src.match(/return fail\(/g) ?? []).length
check(
  "S5: fail 的四个调用点都在,且都 yield*(否则 Effect 不会执行)",
  failCalls === 4 && bareFailCalls === 0,
  `实际: yield*=${failCalls} 裸 return=${bareFailCalls}`,
)

// ---- B: 用真实源码提取的 fail 函数体求值 ----
if (failBody) {
  const m = failBody.match(/const fail = (\([^)]*\))\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\n/)
  if (!m) {
    check("B0: 能从源码构造可执行 fail", false, "正则未匹配")
  } else {
    const params = m[1]
    const body = m[2]
    let observable = false
    let err = ""
    try {
      // body 是 TS 源码,含类型注解。只取参数名(忽略类型注解),不做字面量替换。
      // 若 body 内部还有类型注解,求值会抛错,B1 会失败而不是静默通过。
      const cleanParams = (params.match(/[A-Za-z_$][\w$]*\s*\??\s*(?=:|,|\))/g) ?? [])
        .map((p) => p.trim().replace(/\?$/, ""))
        .join(", ")
      // 注入一个会记录调用的 Effect.logInfo 替身;若函数体从不调用它,
      // observable 保持 false —— 正是"诊断被丢弃"的机器可判定形式。
      const calls = []
      const Effect = {
        logInfo: (...args) => {
          calls.push(args)
          return { tag: "log" }
        },
        logWarning: (...args) => {
          calls.push(args)
          return { tag: "log" }
        },
        logError: (...args) => {
          calls.push(args)
          return { tag: "log" }
        },
      }
      const fn = new Function("Effect", `return function fail(${cleanParams}) {${body}}`)
      fn(Effect)("probe message", { head: "deadbeef blob 42" })
      observable = calls.length > 0
    } catch (e) {
      err = e.message
    }
    check(
      "B1: 传入 msg 后 fail 必须产生可观测输出(用真实实现函数体求值)",
      observable,
      err ? `求值异常: ${err}` : "实际: fail 调用后没有任何日志调用,诊断被丢弃",
    )
  }
}

// ---- B2: 正常返回类型未被改坏 ----
check(
  "B2: 正常路径仍返回 map(修复不得把成功路径改成 undefined)",
  /return map\b/.test(src),
  "",
)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
