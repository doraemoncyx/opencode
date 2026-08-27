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
  // 用 GBK 回环 + CJK 计数对比判定真实编码。关键判别：真正的 GBK 文件按 UTF-8
  // 解码不会得到 CJK 字符（CJK 在 UTF-8 中是 3 字节，而 GBK 是 2 字节对），而真正的
  // UTF-8 文件按 UTF-8 解码必然得到 CJK。因此 UTF-8 解码无 CJK、GBK 解码有 CJK 时判 GBK。
  const gbkText = gbkTextDecoder().decode(bytes)
  if (!iconv.encode(gbkText, "gbk").equals(Buffer.from(bytes))) return "utf-8"
  const utf8Cjk = countCjk(new TextDecoder("utf-8").decode(bytes))
  const gbkCjk = countCjk(gbkText)
  if (utf8Cjk === 0 && gbkCjk > 0) return "gbk"
  return "utf-8"
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
