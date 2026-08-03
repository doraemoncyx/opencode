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
