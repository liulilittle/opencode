import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})

// prefix() 的结果会被 shell.ts 拼成 always 授权模式(`<prefix> *`)。
// 字典的生成规则(dict 注释第 2 条)写明 flags 不计数 —— 但这只影响
// **arity 的计数方式**,不代表可以把 flag 从结果里删掉:
//   - 删掉 flag(`git --version` -> `git`)会把授权放大成整个程序;
//   - 把 flag 当子命令(`pip --index-url http://corp` -> `pip --index-url`)
//     会让通配符吞掉取值,`pip --index-url <任意值>` 都被放行。
// 正确做法:arity 数位置参数,边界切在原始 token 上 —— flag 与其取值一起固化。
test("flags never count toward arity", () => {
  expect(BashArity.prefix(["git", "--version"])).toEqual(["git", "--version"])
  expect(BashArity.prefix(["npm", "-v"])).toEqual(["npm", "-v"])
  expect(BashArity.prefix(["git", "checkout", "-b", "feature"])).toEqual(["git", "checkout"])
})

test("flag values are pinned into the grant pattern", () => {
  expect(BashArity.prefix(["pip", "--index-url", "http://corp.example", "install", "pkg"])).toEqual([
    "pip",
    "--index-url",
    "http://corp.example",
  ])
  expect(BashArity.prefix(["git", "-C", "/repo", "status"])).toEqual(["git", "-C", "/repo"])
  expect(BashArity.prefix(["python", "-c", "import os"])).toEqual(["python", "-c", "import os"])
})

test("flags after the subcommand keep the subcommand", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "-d"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["npm", "run", "dev", "--silent"])).toEqual(["npm", "run", "dev"])
})
