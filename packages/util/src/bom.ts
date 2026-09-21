export * as Bom from "./bom.js"

import { Effect } from "effect"
import type { FSUtil } from "./fs-util.js"
import { decodeText, detectEncoding, encodeText, type FileEncoding } from "./encoding.js"

const code = 0xfeff
const value = String.fromCharCode(code)

export function split(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  return bom ? value + stripped : stripped
}

export function has(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

export function decodeBytes(content: Uint8Array) {
  const encoding = detectEncoding(content)
  return { ...split(decodeText(content, encoding)), encoding }
}

export function syncBytes(content: Uint8Array, bom: boolean) {
  const encoding = detectEncoding(content)
  const decoded = decodeText(content, encoding)
  const current = split(decoded)
  const canonical = bom ? value + current.text : current.text
  return {
    text: current.text,
    encoding,
    bytes: decoded === canonical ? undefined : asBytes(writeFileEncoded(canonical, encoding)),
  }
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filepath: string) {
  return decodeBytes(yield* fs.readFile(filepath))
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (fs: FSUtil.Interface, filepath: string, bom: boolean) {
  const synced = syncBytes(yield* fs.readFile(filepath), bom)
  if (synced.bytes) yield* fs.writeWithDirs(filepath, synced.bytes)
  return synced.text
})

// GBK 无 BOM 概念：剥离 \uFEFF，避免 iconv 将不可编码的 U+FEFF 替换成 '?'
export function writeFileEncoded(text: string, encoding: FileEncoding) {
  if (encoding === "gbk") return encodeText(text.replace(/^\uFEFF/, ""), "gbk")
  return text
}

function asBytes(content: string | Uint8Array) {
  return typeof content === "string" ? new TextEncoder().encode(content) : content
}
