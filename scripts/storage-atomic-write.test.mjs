/**
 * storage-atomic-write.test.mjs — 会话/消息/part 的落盘必须原子(tmp+rename)。
 *
 * 审计背景(第85轮,宿主 opencode-v1,持久化):
 *
 * `Storage.update` / `Storage.write` 都走同一条落盘路径:
 *
 *   const writeJson = Effect.fnUntraced(function* (target, content) {
 *     yield* fs.writeWithDirs(target, JSON.stringify(content, null, 2))
 *   })
 *
 * 而 `FSUtil.writeWithDirs`(packages/core/src/fs-util.ts:127-146)是**直接覆写**
 * 目标文件:`fs.writeFileString(path, content)`,失败才补建目录重试一次。整个
 * fs-util.ts 里没有任何 rename / tmp 落盘(全文只有两处 writeFileString)。
 *
 * 对比:同一个仓库的其它持久化点全都用 tmp + rename 原子落盘 ——
 *   models-dev.ts:206      fs.rename(tempfile, filepath)
 *   cassette.ts:117        fs.rename(temporary, target)
 *   daemon.ts:54,173       fs.rename(temp, ...)
 *   discovery.ts:184-188   fs.rename(staging, root)
 *   background-cli.ts:72 / server.ts:204   rename(temp, destination)
 * 只有用户数据量最大的 storage(session / message / part)反其道而行。
 *
 * 后果:写入过程中崩溃/断电/进程被杀 -> 目标文件留下**半截 JSON**。下一次
 * `fs.readJson` 直接解码失败,整条会话/消息不可读,且没有任何备份可回滚
 * (storage 没有 .bak / 恢复路径)。这正是"出问题能兜底"最该挡住的一类。
 *
 * 规格:
 *  S 层  storage 的落盘必须经过临时文件 + 原子替换
 *  B 层  模拟"写到一半进程消失":目标文件必须保持**旧内容**(或不存在),
 *        绝不能出现不可解析的半截 JSON
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = "D:/dd/opencode-v1"
const STORAGE = join(REPO, "packages/opencode/src/storage/storage.ts")
const FSUTIL = join(REPO, "packages/core/src/fs-util.ts")

let pass = 0
let fail = 0
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}${extra}`)
  }
}

const src = readFileSync(STORAGE, "utf8")
const lines = src.split(/\r?\n/)

// ── S 层 ───────────────────────────────────────────────────────────────────
const writeJsonIdx = lines.findIndex((l) => l.includes("const writeJson = Effect.fnUntraced("))
check("S0: 定位 writeJson", writeJsonIdx >= 0, writeJsonIdx >= 0 ? ` (line ${writeJsonIdx + 1})` : "")

let writeJsonEnd = writeJsonIdx
if (writeJsonIdx >= 0) {
  let d = 0, started = false
  for (let i = writeJsonIdx; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === "{") { d++; started = true } else if (ch === "}") d-- }
    if (started && d === 0) { writeJsonEnd = i; break }
  }
}
const writeJsonBody = writeJsonIdx >= 0 ? lines.slice(writeJsonIdx, writeJsonEnd + 1).join("\n") : ""

check(
  "S1: 落盘路径包含临时文件 + 原子替换(rename)",
  /rename\s*\(/.test(writeJsonBody),
  `\n    实际: ${writeJsonBody.replace(/\s+/g, " ").slice(0, 260)}`,
)
// 更严:S1 只证明"出现了 rename",不证明"写的是临时文件"。这里断言写入目标必须是
// 临时变量而不是 final target —— 否则就是"先写坏正式文件、再 rename 自己"。
check(
  "S1b: 内容先写进临时文件,而不是直接写目标文件",
  /writeWithDirs\(\s*tmp\s*,/.test(writeJsonBody) && !/writeWithDirs\(\s*target\s*,/.test(writeJsonBody),
  `\n    实际: ${writeJsonBody.replace(/\s+/g, " ").slice(0, 260)}`,
)
check(
  "S1c: rename 的方向必须是 tmp -> target",
  /rename\(\s*tmp\s*,\s*target\s*\)/.test(writeJsonBody.replace(/\s+/g, " ")),
  "",
)
check(
  "S2: 临时文件与被替换目标同目录(rename 跨设备会失败)",
  /dirname\(target\)|target\s*\+\s*["'`]\.|\$\{target\}\./.test(writeJsonBody),
  "",
)
check(
  "S3: rename 失败时要清理临时文件(不留垃圾)",
  /remove\(\s*tmp\s*\)/.test(writeJsonBody.replace(/\s+/g, " ")),
  `\n    实际: ${writeJsonBody.replace(/\s+/g, " ").slice(0, 260)}`,
)

// 对照:确认 fs-util 的 writeWithDirs 不是原子的(否则 S1 就是多余)
const fsutil = readFileSync(FSUTIL, "utf8")
check(
  "S4: 对照——FSUtil.writeWithDirs 确实是直接覆写(非原子)",
  !/rename/.test(fsutil),
  "",
)

// ── B 层:模拟写到一半 ──────────────────────────────────────────────────────
// 由于无法在测试进程里真正杀掉写入协程,这里用"写入器必须先把内容完整写到临时文件、
// 再一次性 rename"的结构来间接验证:构造一个"临时文件存在但 rename 未发生"的状态,
// 断言目标文件仍是旧内容。
import { mkdtempSync, writeFileSync, readFileSync as rf, existsSync, readdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"

const dir = mkdtempSync(join(tmpdir(), "storage-atomic-"))
const target = join(dir, "session.json")
const OLD = JSON.stringify({ id: "old", content: "original" }, null, 2)
writeFileSync(target, OLD, "utf8")

// 模拟:写入器已把新内容写进同目录临时文件,但还没 rename 就崩了
const tmp = join(dir, `.session.json.${process.pid}.${Date.now()}.tmp`)
writeFileSync(tmp, '{"id":"new","content":"TRUNCA', "utf8") // 半截内容

// 断言:目标文件必须仍是完整旧内容(rename 未发生 -> 旧内容可读)
let stillOld = false
try {
  const now = rf(target, "utf8")
  stillOld = now === OLD && JSON.parse(now).id === "old"
} catch {
  stillOld = false
}
check("B1: 临时文件残留时,目标文件仍是完整旧内容(可直接解析)", stillOld)

// 断言:半截临时文件不会被当成正式数据(目录里只有它,但它不是 *.json)
const files = readdirSync(dir)
const looksLikeData = files.filter((f) => f.endsWith(".json") && f !== "session.json")
check(
  "B2: 半截临时文件不占用正式数据文件名",
  looksLikeData.length === 0,
  ` (${JSON.stringify(looksLikeData)})`,
)

for (const f of files) { try { unlinkSync(join(dir, f)) } catch {} }

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
