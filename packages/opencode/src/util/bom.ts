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
  const encoded = current.encoding === "gbk" ? encodeText(join(current.text, bom), "gbk") : join(current.text, bom)
  yield* fs.writeWithDirs(filePath, encoded)
  return current.text
})

export const writeFileEncoded = (text: string, encoding: FileEncoding) => {
  if (encoding === "gbk") return encodeText(text, "gbk")
  return text
}
