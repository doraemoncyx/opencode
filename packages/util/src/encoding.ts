import iconv from "iconv-lite"

export type FileEncoding = "utf-8" | "gb18030"

export function detectEncoding(bytes: Uint8Array): FileEncoding {
  let utf8Ok = true
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    utf8Ok = false
  }
  if (!utf8Ok) return "gb18030"
  // EF BB BF 前缀按惯例视为 UTF-8 BOM（GB18030 恰好也能把它解码成两个汉字并回环）
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes.length === 0 || !bytes.some((byte) => byte >= 0x80)) return "utf-8"

  // 字节同时是合法 UTF-8 与合法 GB18030 时（约 8% 的 GB18030 汉字恰好构成合法 UTF-8），
  // 先做 GB18030 回环确保两种解释都成立，再做可行性对比：真正的 UTF-8 文本（含 CJK、
  // 拉丁、西里尔等）按 UTF-8 解码是有意义的字符，不能仅因 GB18030 也能解码出 CJK 就改判；
  // 只有 UTF-8 解码出现控制/不可打印字符、而 GB18030 解码给出可读文本时（例如回环样例
  // 0xC2 0x80：UTF-8 为 U+0080 控制符，GB18030 为「聙」），才判 GB18030。
  const gbText = gb18030TextDecoder().decode(bytes)
  if (!iconv.encode(gbText, "gb18030").equals(Buffer.from(bytes))) return "utf-8"
  const utf8Text = new TextDecoder("utf-8").decode(bytes)
  if (countCjk(utf8Text) > 0) return "utf-8"
  if (countCjk(gbText) === 0) return "utf-8"
  // 真正的 UTF-8 文本解码后是连贯可读文本（ASCII/拉丁/希腊/西里尔/常用符号）；
  // GB18030 回环样例按 UTF-8 解码则常出现控制符或生僻字符。仅后者判 GB18030，
  // 避免把 café、Привет 这类合法 UTF-8 误判成 GB18030。
  if (isCoherentText(utf8Text)) return "utf-8"
  return "gb18030"
}

// 文件内容的编码判定，比 shell 输出保守：只有严格 UTF-8 解码失败才判 GB18030。
// 文件工具会按此结果重新编码写回，误判会把合法 UTF-8 文件（emoji、假名等触发的
// 回环样例）写坏，所以这里不做回环启发式，宁可漏判也不误判。
export function detectFileEncoding(bytes: Uint8Array): FileEncoding {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return "utf-8"
  } catch {
    return "gb18030"
  }
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
  return gb18030TextDecoder().decode(bytes)
}

// GB18030 是 GBK 的超集，解码即沿用 gb18030 标签（WHATWG 里 gbk 的解码器本就是 gb18030 解码器）。
// Bun 全局 Encoding 类型只收录了部分标签，"gb18030" 是合法 WHATWG 标签但类型未收录。
export const gb18030TextDecoder = () => new TextDecoder("gb18030" as never)

export function encodeText(text: string, encoding: FileEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text)
  return iconv.encode(text, "gb18030")
}

// 文本能否被目标编码无损表示。编码器会把不支持的字符替换成 '?' 或改写成别的码位，
// 写回前用它拦截，避免静默丢数据。
export function isEncodable(text: string, encoding: FileEncoding): boolean {
  return decodeText(encodeText(text, encoding), encoding) === text
}

// 一段输出可能同时含两种编码：现代工具（python/node/git）写 UTF-8，Windows 原生工具（cmd、svn、
// PowerShell 自己的报错信息）写 GB18030（GBK 超集）。0x0a 在两种编码里都是单字节，不会出现在多字节
// 字符内部，所以按行切分是安全的：每行各自判定编码，整流只用一个编码解会让少数派那些行整片乱码。
//
// `skip` 是窗口开头已被调用方交付过的字节数，对应字符会被丢弃；`consumed` 是本窗口被解码的字节数，
// 供调用方推进字节游标。
export function decodeShellOutput(bytes: Uint8Array, skip = 0): { text: string; consumed: number } {
  const lines = []
  for (let start = 0; start < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, start)
    const end = newline === -1 ? bytes.length : newline + 1
    const slice = bytes.subarray(start, end)
    const encoding = detectEncoding(slice)
    // 带换行的行必然完整；窗口末尾没有换行的那行可能被页边界从字符中间截断，只取完整字符，
    // 尾部留给下一页重读。
    const used = newline === -1 ? completeBytes(slice, encoding) : slice.length
    lines.push({ start, encoding, used, text: decodeText(slice.subarray(0, used), encoding) })
    start = end
  }
  let skipped = 0
  for (const line of lines) {
    const limit = Math.min(skip - line.start, line.used)
    if (limit <= 0) break
    skipped += completeCharacters(bytes.subarray(line.start, line.start + line.used), line.encoding, limit)
  }
  return {
    text: lines
      .map((line) => line.text)
      .join("")
      .slice(skipped),
    consumed: lines.reduce((total, line) => total + line.used, 0),
  }
}

// 页可能从字符中间开始读，而 GB18030 不是自同步编码：从多字节字符内部偏移解码会错位其后所有字符。
// 所以按字节步长推进，页边界要么落在完整字符上，要么就把尾巴留给下一页。
const characterSize = (bytes: Uint8Array, encoding: FileEncoding, offset: number) => {
  const byte = bytes[offset]!
  if (encoding === "utf-8") {
    if (byte < 0xc0) return 1
    if (byte < 0xe0) return 2
    if (byte < 0xf0) return 3
    return 4
  }
  // GB18030 由首字节 0x81-0xFE 起首：第二字节落在 0x30-0x39 时是四字节序列，否则是两字节。
  // 0x80 既不是首字节也不是单字节字符，按 1 字节算以保持偏移对齐。
  if (byte < 0x81) return 1
  const second = bytes[offset + 1]
  return second !== undefined && second >= 0x30 && second <= 0x39 ? 4 : 2
}

// 完整字符前缀的字节长度：末尾若落在字符中间则裁掉残字节。分块读取用它先裁再判定，
// 否则被页边界截断的合法 UTF-8 大文件会被尾部残字节误判成 GB18030。
export const completeBytes = (bytes: Uint8Array, encoding: FileEncoding) => {
  let offset = 0
  while (offset < bytes.length) {
    const size = characterSize(bytes, encoding, offset)
    if (offset + size > bytes.length) break
    offset += size
  }
  return offset
}

const completeCharacters = (bytes: Uint8Array, encoding: FileEncoding, limit: number) => {
  let offset = 0
  let count = 0
  while (offset < limit) {
    const size = characterSize(bytes, encoding, offset)
    if (offset + size > limit) break
    offset += size
    count += 1
  }
  return count
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
