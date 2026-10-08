import { describe, expect, test } from "bun:test"
import iconv from "iconv-lite"
import {
  decodeShellOutput,
  decodeText,
  detectEncoding,
  detectFileEncoding,
  encodeText,
  isEncodable,
} from "./encoding.js"

const gbChinese = (text: string) => Buffer.from(iconv.encode(text, "gb18030"))
const utf8Chinese = (text: string) => Buffer.from(text, "utf-8")

describe("detectEncoding", () => {
  test("detects UTF-8 Chinese", () => {
    expect(detectEncoding(utf8Chinese("这是中文注释"))).toBe("utf-8")
  })

  test("detects GB18030 Chinese", () => {
    expect(detectEncoding(gbChinese("这是中文注释"))).toBe("gb18030")
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

  test("detects a GB18030 file whose bytes are also valid UTF-8", () => {
    // 0xC2 0x80 是合法 UTF-8 序列，同时是 GB18030 汉字 "聙" —— 旧启发式会误判成 utf-8
    const lookalike = Buffer.from(iconv.encode("聙", "gb18030"))
    expect(Buffer.from(lookalike).toString("hex")).toBe("c280")
    expect(detectEncoding(lookalike)).toBe("gb18030")
  })

  test("detects a GB18030 file with a mix of ASCII and one lookalike char", () => {
    const bytes = Buffer.concat([Buffer.from("// note: "), iconv.encode("聙", "gb18030")])
    expect(detectEncoding(bytes)).toBe("gb18030")
  })

  test("keeps non-CJK UTF-8 text as utf-8", () => {
    // 这些合法 UTF-8 字节恰好也能被 GB18030 解码，不能因为它们回环成功就误判为 GB18030
    for (const text of ["café", "naïve", "Grüße", "Привет", "Ω≈ç"]) {
      expect(detectEncoding(Buffer.from(text, "utf-8"))).toBe("utf-8")
    }
  })
})

describe("detectFileEncoding", () => {
  test("keeps valid UTF-8 as utf-8 even when the aggressive detector would guess gb18030", () => {
    // 这些串在 detectEncoding 里会误判成 gb18030，文件工具写回时会把它们写坏，所以文件判定要保守
    for (const text of ["这是中文注释", "café", "😀", "hi 😀", "한국어 테스트", "ひらがなだけ"])
      expect(detectFileEncoding(Buffer.from(text, "utf-8"))).toBe("utf-8")
  })

  test("detects gb18030 only when the bytes are not valid UTF-8", () => {
    expect(detectFileEncoding(gbChinese("这是中文注释"))).toBe("gb18030")
    // 0x80 是非法 UTF-8 字节，落在 GB18030 分支
    expect(detectFileEncoding(Buffer.from([0x68, 0x69, 0x80]))).toBe("gb18030")
  })

  test("treats pure ASCII and empty input as utf-8", () => {
    expect(detectFileEncoding(Buffer.from("hello world, 123"))).toBe("utf-8")
    expect(detectFileEncoding(new Uint8Array())).toBe("utf-8")
  })
})

describe("isEncodable", () => {
  test("accepts text representable in the target encoding", () => {
    expect(isEncodable("这是中文，测试 123", "gb18030")).toBe(true)
    expect(isEncodable("café Привет", "utf-8")).toBe(true)
  })

  test("GB18030 is a superset of GBK, so emoji and four-byte scalars are representable", () => {
    // 这些在 GBK 编码器里会变成 '?'，GB18030 的 4 字节形式能无损承载
    expect(isEncodable("😀", "gb18030")).toBe(true)
    expect(isEncodable("\u{20000}", "gb18030")).toBe(true)
    expect(isEncodable("\u{10FFFF}", "gb18030")).toBe(true)
  })

  test("rejects the handful of scalars the GB18030 encoder cannot round-trip", () => {
    // iconv 把 U+E5E5 映射到另一个码位，轮转后不再相等，写回前必须拦截
    expect(isEncodable("\uE5E5", "gb18030")).toBe(false)
  })
})

describe("decodeText", () => {
  test("preserves the UTF-8 BOM character", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("abc")])
    expect(decodeText(bytes, "utf-8")).toBe("\uFEFFabc")
  })

  test("decodes GB18030 bytes", () => {
    expect(decodeText(gbChinese("测试"), "gb18030")).toBe("测试")
  })
})

describe("decodeShellOutput", () => {
  test("decodes UTF-8 and GB18030 lines in the same capture", () => {
    const bytes = Buffer.concat([gbChinese("测试"), Buffer.from("\n"), utf8Chinese("utf8 中文"), Buffer.from("\n")])
    const page = decodeShellOutput(bytes)
    expect(page.text).toBe("测试\nutf8 中文\n")
    expect(page.consumed).toBe(bytes.length)
  })

  test("decodes a GB18030 line that follows a UTF-8 line", () => {
    const bytes = Buffer.concat([utf8Chinese("café\n"), gbChinese("测试"), Buffer.from("\n")])
    expect(decodeShellOutput(bytes).text).toBe("café\n测试\n")
  })

  test("drops the skipped prefix characters", () => {
    const bytes = Buffer.concat([Buffer.from("abc\n"), gbChinese("中文")])
    const page = decodeShellOutput(bytes, 4)
    expect(page.text).toBe("中文")
    expect(page.consumed).toBe(bytes.length)
  })

  test("drops a trailing line cut in the middle of a character", () => {
    const page = decodeShellOutput(gbChinese("中文").subarray(0, 3))
    expect(page.text).toBe("中")
    expect(page.consumed).toBe(2)
  })

  test("decodes an empty capture", () => {
    expect(decodeShellOutput(new Uint8Array())).toEqual({ text: "", consumed: 0 })
  })
})

describe("encodeText", () => {
  test("GB18030 round-trips through decodeText", () => {
    const text = "这是中文，测试回环 123"
    expect(decodeText(encodeText(text, "gb18030"), "gb18030")).toBe(text)
  })

  test("UTF-8 round-trips through decodeText", () => {
    const text = "中文 utf-8 回环 456"
    expect(decodeText(encodeText(text, "utf-8"), "utf-8")).toBe(text)
  })
})
