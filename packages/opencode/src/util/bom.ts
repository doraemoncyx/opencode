import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { detectEncoding, decodeText, encodeText, type FileEncoding } from "@opencode-ai/core/util/encoding"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filePath: string) {
  const bytes = yield* fs.readFile(filePath)
  const encoding = detectEncoding(bytes)
  const text = decodeText(bytes, encoding)
  return { ...split(text), encoding }
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (fs: FSUtil.Interface, filePath: string, bom: boolean) {
  const current = yield* readFile(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, writeFileEncoded(join(current.text, bom), current.encoding))
  return current.text
})

// GBK 无 BOM 概念：剥离 \uFEFF，避免 iconv 将不可编码的 U+FEFF 替换成 '?'
export const writeFileEncoded = (text: string, encoding: FileEncoding) => {
  if (encoding === "gbk") return encodeText(text.replace(/^\uFEFF/, ""), "gbk")
  return text
}
