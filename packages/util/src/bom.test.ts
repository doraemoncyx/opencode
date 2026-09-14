import { expect, test } from "bun:test"
import iconv from "iconv-lite"
import { Bom } from "./bom.js"

test.each([
  { prefix: "", bom: false, expected: undefined },
  { prefix: "", bom: true, expected: "\uFEFF" },
  { prefix: "\uFEFF", bom: false, expected: "" },
  { prefix: "\uFEFF", bom: true, expected: undefined },
  { prefix: "\uFEFF\uFEFF", bom: false, expected: "" },
  { prefix: "\uFEFF\uFEFF", bom: true, expected: "\uFEFF" },
])("syncBytes(%j)", (row) => {
  const encoder = new TextEncoder()
  const text = "a\uFEFF\u00e9"
  const input = encoder.encode(row.prefix + text)

  expect(Bom.syncBytes(input, row.bom)).toEqual({
    text,
    encoding: "utf-8",
    bytes: row.expected === undefined ? undefined : encoder.encode(row.expected + text),
  })
  expect(input).toEqual(encoder.encode(row.prefix + text))
})

test("decodes GBK bytes and re-encodes the round trip without a BOM", () => {
  const source = "这是中文\n第二行"
  const bytes = iconv.encode(source, "gbk")
  const decoded = Bom.decodeBytes(bytes)

  expect(decoded).toEqual({ bom: false, text: source, encoding: "gbk" })
  expect(Bom.writeFileEncoded(decoded.text, decoded.encoding)).toEqual(Buffer.from(iconv.encode(source, "gbk")))
})

test("strips a leading BOM character when encoding as GBK", () => {
  expect(Bom.writeFileEncoded("\uFEFF新内容", "gbk")).toEqual(Buffer.from(iconv.encode("新内容", "gbk")))
  expect(Bom.writeFileEncoded("\uFEFF新内容", "utf-8")).toBe("\uFEFF新内容")
})

test("syncBytes re-encodes GBK bytes in GBK when the BOM state changes", () => {
  const input = iconv.encode("中文内容", "gbk")

  expect(Bom.syncBytes(input, true)).toEqual({
    text: "中文内容",
    encoding: "gbk",
    bytes: iconv.encode("中文内容", "gbk"),
  })
  expect(Bom.syncBytes(input, false).bytes).toBeUndefined()
})
