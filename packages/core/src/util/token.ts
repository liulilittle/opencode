export * as Token from "./token"

/**
 * 估算比例(字符/token)。旧的固定 4 只适用于英文 prose;本项目真实负载是
 * 中文叙述 + JSON/代码工具输出,同刻样本实测 1.585-2.451 字符/token,
 * 固定 4 会低估 1.6-2.5x,使上下文预检/压缩裁剪在真实超限之后才触发。
 * 现按字符类型分别估算:ASCII 密集(代码/JSON)约 3.2 字符/token,
 * 非 ASCII(中文等)约 1.6 字符/token。
 */
const ASCII_CHARS_PER_TOKEN = 3.2
const WIDE_CHARS_PER_TOKEN = 1.6

export const estimate = (input: string) => {
  if (input.length === 0) return 0
  let wide = 0
  for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 0x7f) wide++
  const ascii = input.length - wide
  return Math.max(0, Math.round(ascii / ASCII_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN))
}
