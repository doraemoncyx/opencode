import { describe, expect, test } from "bun:test"
import iconv from "iconv-lite"
import { decodeShellOutput, decodeText, detectEncoding, encodeText } from "./encoding.js"

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

  test("keeps non-CJK UTF-8 text as utf-8", () => {
    // 这些合法 UTF-8 字节恰好也能被 GBK 解码，不能因为它们回环成功就误判为 GBK
    for (const text of ["café", "naïve", "Grüße", "Привет", "Ω≈ç"]) {
      expect(detectEncoding(Buffer.from(text, "utf-8"))).toBe("utf-8")
    }
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

describe("decodeShellOutput", () => {
  test("decodes UTF-8 and GBK lines in the same capture", () => {
    const bytes = Buffer.concat([
      gbkChinese("测试"),
      Buffer.from("\n"),
      utf8Chinese("utf8 中文"),
      Buffer.from("\n"),
    ])
    const page = decodeShellOutput(bytes)
    expect(page.text).toBe("测试\nutf8 中文\n")
    expect(page.consumed).toBe(bytes.length)
  })

  test("decodes a GBK line that follows a UTF-8 line", () => {
    const bytes = Buffer.concat([utf8Chinese("café\n"), gbkChinese("测试"), Buffer.from("\n")])
    expect(decodeShellOutput(bytes).text).toBe("café\n测试\n")
  })

  test("drops the skipped prefix characters", () => {
    const bytes = Buffer.concat([Buffer.from("abc\n"), gbkChinese("中文")])
    const page = decodeShellOutput(bytes, 4)
    expect(page.text).toBe("中文")
    expect(page.consumed).toBe(bytes.length)
  })

  test("drops a trailing line cut in the middle of a character", () => {
    const page = decodeShellOutput(gbkChinese("中文").subarray(0, 3))
    expect(page.text).toBe("中")
    expect(page.consumed).toBe(2)
  })

  test("decodes an empty capture", () => {
    expect(decodeShellOutput(new Uint8Array())).toEqual({ text: "", consumed: 0 })
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
