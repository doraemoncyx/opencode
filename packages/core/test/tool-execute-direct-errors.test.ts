import { expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Flag } from "@opencode/core/flag"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { permissionService } from "./lib/permission"

// Fork-only: the guidance an unknown Code Mode tool name produces. Kept out of tool-execute.test.ts so
// that file stays byte-identical to upstream and no longer has to be resolved on every merge.

const context = {
  sessionID: Session.ID.make("ses_execute_direct"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute_direct"),
  id: Tool.CallID.make("call_execute_direct"),
  progress: () => Effect.void,
}

const allowAll = permissionService({ assert: () => Effect.void })

const vmFlag = (codemode_vm: boolean): Flag.Interface => {
  const resolve: Flag.Interface["resolve"] = (entries) =>
    Flag.resolve({
      entries,
      channel: codemode_vm ? "dev" : "latest",
      overrides: `${codemode_vm ? "" : "-"}codemode_vm`,
    })
  const all = Effect.sync(() => resolve([]))
  return {
    resolve,
    all,
    enabled: (key) => Effect.map(all, (flags) => flags[key].enabled),
  }
}

const createCodeModeWithDirect = (direct: ReadonlySet<string>) =>
  CodeModeTool.create(
    { tools: new Map(), direct },
    (_, tool, input, context) => execute(tool, input, context),
    allowAll,
    vmFlag(false),
  )

test("an unknown tool that the model calls directly elsewhere names the real remedy", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch"])).execute(
      { code: "return await tools.webfetch({ url: 'https://example.com' })" },
      context,
    ),
  )

  expect(result.metadata).toEqual({ toolCalls: [], error: true })
  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "Unknown tool 'webfetch'.",
        "`webfetch` is not a Code Mode tool. Call it directly, outside `execute`.",
      ].join("\n"),
    },
  ])
})

test("an unknown tool outside the direct list keeps the search hint", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch"])).execute({ code: "return await tools.missing({})" }, context),
  )

  expect(result.content).toEqual([
    {
      type: "text",
      text: ["Unknown tool 'missing'.", "Use search to find available tools."].join("\n"),
    },
  ])
})

test("an unknown child path resolves against its first segment", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch"])).execute({ code: "return await tools.webfetch.extra({})" }, context),
  )

  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "Unknown tool 'webfetch.extra'.",
        "`webfetch` is not a Code Mode tool. Call it directly, outside `execute`.",
      ].join("\n"),
    },
  ])
})

// The Code Mode runtime already honors `tools.search(...)` for the bare `search` global, and emits
// its own "Use search to find available tools." suggestion, so those cases are covered upstream and
// are not re-tested here.

test("a direct tool called as a global names the direct call and the sandbox alternative", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch", "read"])).execute(
      { code: "return await webfetch({ url: 'https://example.com' })" },
      context,
    ),
  )

  expect(result.metadata).toEqual({ toolCalls: [], error: true })
  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "ReferenceError: Unknown identifier 'webfetch'. (line 1, col 14)",
        "`webfetch` is not available inside `execute`. Use `fetch(url, init)` there, or call the tool directly.",
      ].join("\n"),
    },
  ])
})

test("another direct tool called as a global points back at the direct call", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch", "read"])).execute(
      { code: "return read({ filePath: '/a' })" },
      context,
    ),
  )

  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "ReferenceError: Unknown identifier 'read'. (line 1, col 8)",
        "`read` is not available inside `execute`. Call it directly, outside `execute`.",
      ].join("\n"),
    },
  ])
})

test("a host global the sandbox does not bind names what to use instead", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set()).execute(
      { code: 'return await fetch("https://example.com", { signal: AbortSignal.timeout(1000) })' },
      context,
    ),
  )

  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "ReferenceError: Unknown identifier 'AbortSignal'. (line 1, col 53)",
        "`execute` has no timers or `AbortSignal`; `fetch` there already applies its own timeout.",
      ].join("\n"),
    },
  ])
})

test("an unremarkable unknown identifier keeps the bare reference error", async () => {
  const result = await Effect.runPromise(
    createCodeModeWithDirect(new Set(["webfetch"])).execute({ code: "return missing__name" }, context),
  )

  expect(result.content).toEqual([
    { type: "text", text: "ReferenceError: Unknown identifier 'missing__name'. (line 1, col 8)" },
  ])
})
