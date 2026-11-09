// 第 86 轮:Storage.list 的键还原假设
//
// 背景:`writeJson`(第 85 轮)改为先写 `<target>.<pid>.<ts>.tmp` 再 rename。
// rename 失败路径已清理 tmp,但**进程在 writeWithDirs 与 rename 之间被杀**时
// tmp 会留在同一目录里。这是原子写的已知代价,不是 bug —— 前提是读侧不把
// tmp 当数据。
//
// `Storage.list` 的实现:
//   glob("**/*", { cwd, include: "file" })
//     .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
//
// `x.slice(0, -5)` 盲切末尾 5 个字符(假设 ".json" 恰好 5 个)。
// 一个名为 `ses_abc.json.4242.1731111111111.tmp` 的残留文件会被还原成键
// `ses_abc.json.4242.1731111111111.tmp` 去掉末 5 字符 =
// `ses_abc.json.4242.1731111111`.
//
// 断言(S = 静态形态,B = 行为):
//   S0 定位 list 实现
//   S1 list 必须只接受 .json 结尾的文件(显式后缀过滤)
//   S2 list 必须按 ".json" 长度剥离,而不是硬编码 -5
//   S3 对照:writeJson 的临时文件确实以 .tmp 结尾
//   B1 目录里有合法 {a.json} 与残留 {a.json.<pid>.<ts>.tmp} 时,list 只返回 a
//   B2 只有残留 tmp、没有合法 json 时,list 返回空
//   B3 剥离后必须精确还原文件名(list 结果能直接用于 read)

import fs from "node:fs"
import path from "node:path"

const SRC = "D:/dd/opencode-v1/packages/opencode/src/storage/storage.ts"

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

function extract(fnName) {
  const start = src.indexOf(`const ${fnName}: Interface["${fnName}"]`)
  if (start < 0) return null
  const end = src.indexOf("\n    })", start)
  return end < 0 ? src.slice(start) : src.slice(start, end + 7)
}

const listBody = extract("list")

// writeJson 的声明形态与 Interface 方法不同:
//   const writeJson = Effect.fnUntraced(function* (target, content) { ... })
// 单独定位,不复用 extract。
function extractWriteJson() {
  const start = src.indexOf("const writeJson = ")
  if (start < 0) return null
  const end = src.indexOf("\n    })", start)
  return end < 0 ? src.slice(start) : src.slice(start, end + 7)
}

// ---- S0 ----
check("S0: 定位 list 实现", !!listBody && listBody.includes("glob"), listBody ? "" : "未找到")

// ---- S1: 必须有显式 .json 过滤 ----
check(
  "S1: list 必须显式只接受 .json 结尾的文件",
  !!listBody && /\.endsWith\(/.test(listBody) && /\.json/.test(listBody),
  listBody ? `实际: ${listBody.replace(/\s+/g, " ").slice(0, 300)}` : "",
)

// ---- S2: 必须按 ".json".length 剥离,而不是硬编码 -5 ----
check(
  "S2: list 必须按 .json 后缀长度剥离,而不是硬编码 -5",
  !!listBody && !/slice\(\s*0\s*,\s*-5\s*\)/.test(listBody),
  listBody ? `实际仍含 slice(0, -5)` : "",
)

// ---- S3: 对照,证明 writeJson 的残留确实以 .tmp 结尾 ----
const writeJson = extractWriteJson()
check(
  "S3: 对照——writeJson 的临时文件以 .tmp 结尾(残留会进入同一目录)",
  !!writeJson && /\.tmp`/.test(writeJson),
  writeJson ? `实际: ${writeJson.replace(/\s+/g, " ").slice(0, 240)}` : "未定位 writeJson",
)

// ---- 行为层 ----
// 用真实的 Storage 实现跑一遍。Storage 依赖 Effect layer,这里不启动 layer,
// 而是复刻 list 的映射逻辑对**实现源码**做等价判定:把源码里的映射表达式
// 提取出来,用同一批文件名求值。
//
// 这是 B 层的前提:映射表达式必须能从源码里取出。取不出就降级报 FAIL,
// 不允许"取不出就当通过"。
function mapExpr() {
  if (!listBody) return null
  const m = listBody.match(/return\s+result[\s\S]*?\.toSorted/)
  return m ? m[0] : null
}

const map = mapExpr()
check("B0: 能从源码提取 list 的键映射表达式", !!map, map ? "" : "未提取到")

if (map) {
  // 构造一个最小可运行环境:把 result 与 prefix 注入,求值映射表达式。
  // suffix 是实现里声明的常量,必须在源码里取出真实值注入 —— 写死 ".json"
  // 会让"实现改了后缀却不改常量"这类变异逃逸。
  const suffixSrc = listBody.match(/const suffix = "([^"]*)"/)
  const suffixVal = suffixSrc ? suffixSrc[1] : undefined

  const run = (files, prefix) => {
    const body = map
      .replace(/^\s*return\s+result/, "return result")
      .replace(/\)\s*\.toSorted/, ")")
    const fn = new Function("result", "prefix", "path", "suffix", body)
    return fn(files, prefix, path, suffixVal)
  }

  const prefix = ["session"]
  const pid = 4242
  const ts = 1731111111111
  const tmpName = `ses_abc.json.${pid}.${ts}.tmp`

  // B1
  try {
    const got = run(["ses_abc.json", tmpName], prefix)
    const normalized = JSON.stringify(got)
    check(
      "B1: 残留 tmp 与合法 json 并存时,list 只能返回合法键",
      got.length === 1 && got[0][got[0].length - 1] === "ses_abc",
      `实际: ${normalized}`,
    )
  } catch (e) {
    check("B1: 残留 tmp 与合法 json 并存时,list 只能返回合法键", false, `求值异常: ${e.message}`)
  }

  // B2
  try {
    const got = run([tmpName], prefix)
    check(
      "B2: 目录里只有残留 tmp 时,list 必须返回空",
      got.length === 0,
      `实际: ${JSON.stringify(got)}`,
    )
  } catch (e) {
    check("B2: 目录里只有残留 tmp 时,list 必须返回空", false, `求值异常: ${e.message}`)
  }

  // B3
  try {
    const prefix3 = ["session", "project"]
    const got = run([`ses_x.json`, `ses_x.json.1.2.tmp`], prefix3)
    const flat = got.map((x) => x.join("/"))
    check(
      "B3: 嵌套目录下同样过滤,且合法键可精确还原",
      flat.length === 1 && flat[0] === "session/project/ses_x",
      `实际: ${JSON.stringify(flat)}`,
    )
  } catch (e) {
    check("B3: 嵌套目录下同样过滤,且合法键可精确还原", false, `求值异常: ${e.message}`)
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
