import { describe, expect, test } from "bun:test"
import { computeTokenStats, estimateTokens } from "./token-stats"

describe("estimateTokens", () => {
  test("returns zero for empty text", () => {
    expect(estimateTokens("")).toBe(0)
  })

  test("counts each CJK character as one token", () => {
    expect(estimateTokens("你好世界")).toBe(4)
  })

  test("groups non-CJK characters four at a time", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })

  test("mixes CJK and non-CJK counts", () => {
    expect(estimateTokens("你好ab")).toBe(3)
  })
})

describe("computeTokenStats", () => {
  test("uses stored tokens over the generation window when complete", () => {
    expect(
      computeTokenStats(
        {
          time: { created: 1_000, streamed: 5_000, completed: 9_000 },
          content: [{ type: "text", text: "ignored once complete" }],
          tokens: { input: 10, output: 80, reasoning: 20, cache: { read: 0, write: 0 } },
        },
        100_000,
      ),
    ).toEqual({ ttft: undefined, tps: 25 })
  })

  test("derives ttft and a live tps while streaming", () => {
    expect(
      computeTokenStats(
        {
          time: { created: 1_000 },
          content: [
            { type: "reasoning", text: "hello", time: { created: 2_000 } },
            { type: "text", text: "world" },
          ],
        },
        3_000,
      ),
    ).toEqual({ ttft: 1, tps: 4 })
  })

  test("omits tps when no output has been produced", () => {
    expect(computeTokenStats({ time: { created: 1_000 }, content: [] }, 2_000)).toEqual({
      ttft: undefined,
      tps: undefined,
    })
  })
})
