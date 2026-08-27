import { describe, expect, test } from "bun:test"
import iconv from "iconv-lite"
import { decodeText, detectEncoding, encodeText } from "@opencode-ai/core/util/encoding"

const gbkChinese = (text: string) => Buffer.from(iconv.encode(text, "gbk"))
const utf8Chinese = (text: string) => Buffer.from(text, "utf-8")

describe("detectEncoding", () => {
  test("detects UTF-8 Chinese", () => {
    expect(detectEncoding(utf8Chinese("这是中文注释"))).toBe("utf-8")
  })

  test("detects GBK Chinese", () => {
    expect(detectEncoding(gbkChinese("这是中文注释"))).toBe("gbk")
  })

  test("treats pure ASCII as utf-8", () => {
    expect(detectEncoding(Buffer.from("hello world, 123"))).toBe("utf-8")
  })

  test("handles empty input", () => {
    expect(detectEncoding(new Uint8Array())).toBe("utf-8")
  })

  test("keeps UTF-8 BOM files as utf-8", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Chinese("中文")])
    expect(detectEncoding(bytes)).toBe("utf-8")
  })

  test("detects a GBK file whose bytes are also valid UTF-8", () => {
    // 0xC2 0x80 是合法 UTF-8 序列，同时是 GBK 汉字 "聙" —— 旧启发式会误判成 utf-8
    const lookalike = Buffer.from(iconv.encode("聙", "gbk"))
    expect(Buffer.from(lookalike).toString("hex")).toBe("c280")
    expect(detectEncoding(lookalike)).toBe("gbk")
  })

  test("detects a GBK file with a mix of ASCII and one lookalike char", () => {
    const bytes = Buffer.concat([Buffer.from("// note: "), iconv.encode("聙", "gbk")])
    expect(detectEncoding(bytes)).toBe("gbk")
  })
})

describe("decodeText", () => {
  test("preserves the UTF-8 BOM character", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("abc")])
    expect(decodeText(bytes, "utf-8")).toBe("\uFEFFabc")
  })

  test("decodes GBK bytes", () => {
    expect(decodeText(gbkChinese("测试"), "gbk")).toBe("测试")
  })
})

describe("encodeText", () => {
  test("GBK round-trips through decodeText", () => {
    const text = "这是中文，测试回环 123"
    expect(decodeText(encodeText(text, "gbk"), "gbk")).toBe(text)
  })

  test("UTF-8 round-trips through decodeText", () => {
    const text = "中文 utf-8 回环 456"
    expect(decodeText(encodeText(text, "utf-8"), "utf-8")).toBe(text)
  })
})
