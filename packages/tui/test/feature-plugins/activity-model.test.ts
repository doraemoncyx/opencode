import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import {
  computeStats,
  deriveActivity,
  estimateTokens,
  formatActivity,
  formatStats,
  runningToolLabel,
} from "../../src/feature-plugins/prompt/activity-model"

function assistant(input: {
  id?: string
  time: SessionMessageAssistant["time"]
  content: SessionMessageAssistant["content"]
  tokens?: SessionMessageAssistant["tokens"]
}): SessionMessageAssistant {
  return {
    id: input.id ?? "message",
    time: input.time,
    content: input.content,
    ...(input.tokens ? { tokens: input.tokens } : {}),
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
  }
}

function tool(
  name: string,
  state: SessionMessageAssistantTool["state"],
  time: SessionMessageAssistantTool["time"],
): SessionMessageAssistantTool {
  return { type: "tool", id: `tool-${name}`, name, state, time }
}

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

describe("deriveActivity", () => {
  test("is undefined while the session is idle", () => {
    expect(deriveActivity([], { running: false })).toBeUndefined()
  })

  test("reports working when busy with no pending assistant", () => {
    expect(deriveActivity([], { running: true })).toEqual({ label: "Working", queued: 0 })
    const done: SessionMessageInfo[] = [assistant({ time: { created: 1, completed: 2 }, content: [] })]
    expect(deriveActivity(done, { running: true, queued: 1 })).toEqual({ label: "Working", queued: 1 })
  })

  test("reports a running tool with its command and start time", () => {
    const messages: SessionMessageInfo[] = [
      assistant({
        time: { created: 1_000 },
        content: [
          tool(
            "bash",
            { status: "running", input: { command: "ls -la\nsecond line" }, metadata: {} },
            { created: 1_100, ran: 1_200 },
          ),
        ],
      }),
    ]
    expect(deriveActivity(messages, { running: true, queued: 2 })).toEqual({
      label: "Running bash: ls -la",
      since: 1_200,
      queued: 2,
    })
  })

  test("prefers a tool title from metadata over the command", () => {
    const part = tool(
      "read",
      { status: "running", input: { path: "a.ts" }, metadata: { title: "Read a.ts" } },
      { created: 1_100 },
    )
    expect(runningToolLabel(part)).toBe("Running read: Read a.ts")
  })

  test("reports a streaming tool as queued from the message start", () => {
    const messages: SessionMessageInfo[] = [
      assistant({
        time: { created: 1_000 },
        content: [tool("read", { status: "streaming", input: "" }, { created: 1_100 })],
      }),
    ]
    expect(deriveActivity(messages, { running: true })).toEqual({ label: "Queued read", since: 1_000, queued: 0 })
  })

  test("prefers a running tool over a trailing text part", () => {
    const messages: SessionMessageInfo[] = [
      assistant({
        time: { created: 1_000 },
        content: [
          tool("bash", { status: "running", input: { command: "echo hi" }, metadata: {} }, { created: 1_100, ran: 1_150 }),
          { type: "text", text: "streaming prose" },
        ],
      }),
    ]
    expect(deriveActivity(messages, { running: true })?.label).toBe("Running bash: echo hi")
  })

  test("reports thinking with and without a summary title", () => {
    const withTitle: SessionMessageInfo[] = [
      assistant({
        time: { created: 1_000 },
        content: [{ type: "reasoning", text: "**Inspecting files**\n\nbody", time: { created: 2_000 } }],
      }),
    ]
    expect(deriveActivity(withTitle, { running: true })).toEqual({
      label: "Thinking: Inspecting files",
      since: 2_000,
      queued: 0,
    })
    const withoutTitle: SessionMessageInfo[] = [
      assistant({ time: { created: 1_000 }, content: [{ type: "reasoning", text: "plain", time: { created: 2_000 } }] }),
    ]
    expect(deriveActivity(withoutTitle, { running: true })).toEqual({ label: "Thinking", since: 2_000, queued: 0 })
  })

  test("reports writing and waiting for model", () => {
    const writing: SessionMessageInfo[] = [
      assistant({ time: { created: 1_000 }, content: [{ type: "text", text: "hello" }] }),
    ]
    expect(deriveActivity(writing, { running: true })).toEqual({ label: "Writing", since: 1_000, queued: 0 })
    const waiting: SessionMessageInfo[] = [assistant({ time: { created: 1_000 }, content: [] })]
    expect(deriveActivity(waiting, { running: true })).toEqual({ label: "Waiting for model", since: 1_000, queued: 0 })
  })
})

describe("formatActivity", () => {
  test("appends elapsed time and queue count", () => {
    expect(formatActivity({ label: "Running bash: ls", since: 1_000, queued: 2 }, 3_500)).toBe(
      "Running bash: ls \u00b7 2.5s \u00b7 2 queued",
    )
  })

  test("omits elapsed and queue parts when absent", () => {
    expect(formatActivity({ label: "Waiting for model", queued: 0 }, 9_999)).toBe("Waiting for model")
  })
})

describe("computeStats", () => {
  test("aggregates ttft and tps across completed messages", () => {
    const messages: SessionMessageInfo[] = [
      assistant({
        id: "a",
        time: { created: 1_000, streamed: 5_000, completed: 9_000 },
        content: [{ type: "reasoning", text: "x", time: { created: 2_000 } }],
        tokens: { input: 10, output: 80, reasoning: 20, cache: { read: 0, write: 0 } },
      }),
      assistant({
        id: "b",
        time: { created: 10_000, streamed: 12_000, completed: 15_000 },
        content: [{ type: "text", text: "ignored" }],
        tokens: { input: 5, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]
    expect(computeStats(messages, 1_000_000)).toEqual({ ttft: 1_000, tps: 26 })
  })

  test("estimates live tps and ttft while streaming", () => {
    const messages: SessionMessageInfo[] = [
      assistant({
        time: { created: 1_000 },
        content: [
          { type: "reasoning", text: "hello", time: { created: 2_000 } },
          { type: "text", text: "world" },
        ],
      }),
    ]
    expect(computeStats(messages, 3_000)).toEqual({ ttft: 1_000, tps: 4 })
  })

  test("omits ttft but keeps tps when only text parts streamed", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ time: { created: 1_000 }, content: [{ type: "text", text: "abcd" }] }),
    ]
    expect(computeStats(messages, 3_000)).toEqual({ ttft: undefined, tps: 0.5 })
  })

  test("is undefined when nothing has been generated", () => {
    expect(computeStats([assistant({ time: { created: 1_000 }, content: [] })], 2_000)).toBeUndefined()
  })
})

describe("formatStats", () => {
  test("formats ttft and tps together", () => {
    expect(formatStats({ ttft: 500, tps: 12.345 })).toBe("avg ttft 500ms \u00b7 avg 12.3 tps")
  })

  test("drops zero or missing tps", () => {
    expect(formatStats({ tps: 0 })).toBe("")
    expect(formatStats({ ttft: 1_500, tps: 0 })).toBe("avg ttft 1.5s")
  })
})
