import iconv from "iconv-lite"

export type FileEncoding = "utf-8" | "gbk"

export function detectEncoding(bytes: Uint8Array): FileEncoding {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return "utf-8"
  } catch {
    return "gbk"
  }
}

export function decodeText(bytes: Uint8Array, encoding: FileEncoding): string {
  if (encoding === "utf-8") return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  return new TextDecoder("gbk" as any).decode(bytes)
}

export function encodeText(text: string, encoding: FileEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text)
  return iconv.encode(text, "gbk")
}

// 解码 shell 工具收集的原始输出字节，按检测出的编码（UTF-8/GBK）还原为文本
export function decodeShellOutput(bytes: Uint8Array): string {
  return decodeText(bytes, detectEncoding(bytes))
}
