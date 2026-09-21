/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import { ActivityLine } from "../../src/feature-plugins/prompt/activity"

const created = Date.now()

function context(input: {
  status: "idle" | "running"
  messages?: SessionMessageInfo[]
  queued?: unknown[]
}): Context {
  return {
    theme: { text: { subdued: RGBA.fromInts(100, 100, 100) } },
    data: {
      session: {
        status: () => input.status,
        message: { list: () => input.messages ?? [] },
        pending: { list: () => input.queued ?? [] },
      },
    },
  } as unknown as Context
}

test("activity line renders the running tool, elapsed time, and queue count", async () => {
  const messages = [
    {
      id: "message",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: created - 3_000 },
      content: [
        {
          type: "tool",
          id: "tool",
          name: "bash",
          state: { status: "running", input: { command: "ls -la" }, metadata: {} },
          time: { created: created - 2_000, ran: created - 2_500 },
        },
      ],
    },
  ] as unknown as SessionMessageInfo[]
  const app = await testRender(
    () => (
      <ActivityLine
        context={context({ status: "running", messages, queued: [{ type: "user" }] })}
        sessionID="session"
        mode="normal"
        kind="activity"
      />
    ),
    { width: 80, height: 1 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Running bash: ls -la")
    expect(frame).toContain("1 queued")
  } finally {
    app.renderer.destroy()
  }
})

test("activity line is hidden while the session is idle", async () => {
  const app = await testRender(
    () => (
      <ActivityLine
        context={context({ status: "idle" })}
        sessionID="session"
        mode="normal"
        kind="activity"
      />
    ),
    { width: 80, height: 1 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Running")
  } finally {
    app.renderer.destroy()
  }
})

test("stats line renders average ttft and tps", async () => {
  const messages = [
    {
      id: "message",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: created - 6_000, streamed: created - 1_000, completed: created - 500 },
      content: [{ type: "reasoning", text: "x", time: { created: created - 5_000 } }],
      tokens: { input: 10, output: 80, reasoning: 20, cache: { read: 0, write: 0 } },
    },
  ] as unknown as SessionMessageInfo[]
  const app = await testRender(
    () => (
      <ActivityLine
        context={context({ status: "running", messages })}
        sessionID="session"
        mode="normal"
        kind="stats"
      />
    ),
    { width: 80, height: 1 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("avg ttft 1.0s")
    expect(app.captureCharFrame()).toContain("avg 25.0 tps")
  } finally {
    app.renderer.destroy()
  }
})
