import { describe, expect, test } from "bun:test"
import { textBlockTime } from "./block-time"

describe("textBlockTime", () => {
  test("ignores a message with no text block", () => {
    const message = {
      time: { created: 1_000 },
      content: [{ type: "reasoning" as const, time: { created: 1_000, completed: 2_000 } }],
    }
    expect(textBlockTime(message, 0, 5_000)).toBeUndefined()
  })

  test("runs a lone text block from message start to the streamed time", () => {
    const message = {
      time: { created: 1_000, streamed: 4_000, completed: 5_000 },
      content: [{ type: "text" as const }],
    }
    expect(textBlockTime(message, 0, 9_999)).toEqual({ start: 1_000, end: 4_000 })
  })

  test("locates the text by ordinal, not by content index", () => {
    const message = {
      time: { created: 1_000, streamed: 7_000 },
      content: [
        { type: "reasoning" as const, time: { created: 1_000, completed: 3_000 } },
        { type: "text" as const },
        { type: "tool" as const, time: { created: 4_000, completed: 6_000 } },
      ],
    }
    // The first text part is at content index 1.
    expect(textBlockTime(message, 0, 9_999)).toEqual({ start: 3_000, end: 4_000 })
  })

  test("extends the trailing text to now while the message is live", () => {
    const message = {
      time: { created: 1_000 },
      content: [{ type: "reasoning" as const, time: { created: 1_000, completed: 3_000 } }, { type: "text" as const }],
    }
    expect(textBlockTime(message, 0, 9_999)).toEqual({ start: 3_000, end: 9_999 })
  })
})
