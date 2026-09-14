import iconv from "iconv-lite"

export type FileEncoding = "utf-8" | "gbk"

export function detectEncoding(bytes: Uint8Array): FileEncoding {
  let utf8Ok = true
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    utf8Ok = false
  }
  if (!utf8Ok) return "gbk"
  // EF BB BF 前缀按惯例视为 UTF-8 BOM（GB18030 恰好也能把它解码成两个汉字并回环）
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes.length === 0 || !bytes.some((byte) => byte >= 0x80)) return "utf-8"

  // 字节同时是合法 UTF-8 与合法 GBK 时（约 8% 的 GBK 汉字恰好构成合法 UTF-8），
  // 先做 GBK 回环确保两种解释都成立，再做可行性对比：真正的 UTF-8 文本（含 CJK、
  // 拉丁、西里尔等）按 UTF-8 解码是有意义的字符，不能仅因 GBK 也能解码出 CJK 就改判；
  // 只有 UTF-8 解码出现控制/不可打印字符、而 GBK 解码给出可读文本时（例如回环样例
  // 0xC2 0x80：UTF-8 为 U+0080 控制符，GBK 为「聙」），才判 GBK。
  const gbkText = gbkTextDecoder().decode(bytes)
  if (!iconv.encode(gbkText, "gbk").equals(Buffer.from(bytes))) return "utf-8"
  const utf8Text = new TextDecoder("utf-8").decode(bytes)
  if (countCjk(utf8Text) > 0) return "utf-8"
  if (countCjk(gbkText) === 0) return "utf-8"
  // 真正的 UTF-8 文本解码后是连贯可读文本（ASCII/拉丁/希腊/西里尔/常用符号）；
  // GBK 回环样例按 UTF-8 解码则常出现控制符或生僻字符。仅后者判 GBK，
  // 避免把 café、Привет 这类合法 UTF-8 误判成 GBK。
  if (isCoherentText(utf8Text)) return "utf-8"
  return "gbk"
}

// 文本是否为连贯可读文本：仅含空白、ASCII 可见字符、常见拉丁/希腊/西里尔字母与常用符号
function isCoherentText(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code >= 0x20 && code <= 0x7e) continue
    if (code >= 0xa0 && code <= 0x24f) continue
    if (code >= 0x2b0 && code <= 0x2ff) continue
    if (code >= 0x370 && code <= 0x4ff) continue
    if (code >= 0x2000 && code <= 0x2bff) continue
    return false
  }
  return true
}

export function decodeText(bytes: Uint8Array, encoding: FileEncoding): string {
  if (encoding === "utf-8") return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  return gbkTextDecoder().decode(bytes)
}

// Bun 全局 Encoding 类型只收录了部分标签，"gbk" 是合法 WHATWG 标签但类型未收录
export const gbkTextDecoder = () => new TextDecoder("gbk" as never)

export function encodeText(text: string, encoding: FileEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text)
  return iconv.encode(text, "gbk")
}

// 解码 shell 工具收集的原始输出字节，按检测出的编码（UTF-8/GBK）还原为文本
export function decodeShellOutput(bytes: Uint8Array): string {
  return decodeText(bytes, detectEncoding(bytes))
}

// 统计文本中的 CJK 字符（汉字 + 中文标点），供编码判定做对比
function countCjk(text: string): number {
  let count = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      count++
    }
  }
  return count
}
