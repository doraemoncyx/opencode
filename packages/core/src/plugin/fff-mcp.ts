export * as FffMcpPlugin from "./fff-mcp.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Event } from "@opencode/schema/plugin"
import { Effect, Stream } from "effect"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { which } from "../util/which.js"

const SERVER = "fff-mcp"
const ACTION_PREFIX = `${SERVER}_`
const ENV_BIN = "OPENCODE_FFF_MCP_BIN"
const ENV_AUTO = "OPENCODE_FFF_MCP"

export function make(env: NodeJS.ProcessEnv = process.env) {
  return define({
    id: "opencode.fff-mcp",
    effect: Effect.fn("FffMcpPlugin")(function* (ctx) {
      const command = env[ENV_BIN]?.trim() || which(SERVER, env)
      if (!command) {
        yield* Effect.logWarning(
          `${SERVER} executable not found; GBK-aware content search is unavailable. Install ${SERVER} on PATH or set ${ENV_BIN}.`,
        )
        return
      }

      yield* ctx.mcp.transform((editor) => {
        // This built-in runs after config-level MCP registration, so it overrides the command of a
        // configured `fff-mcp` server (for example a wrapper script) with the resolved GBK-capable
        // binary. When nothing was configured, register it by default; skip that auto-registration
        // under test (unless opted in via OPENCODE_FFF_MCP=1) so suites don't spawn the external
        // process, while still exercising the override path.
        const auto = env.NODE_ENV !== "test" || env[ENV_AUTO] === "1"
        if (!editor.get(SERVER) && !auto) return
        editor.set(SERVER, { type: "local", command: [command], codemode: false })
      })

      // The built-in search tools are only the fallback for when fff-mcp is absent, so they are
      // removed whenever the effective server set contains it. Plugin setup runs inside the
      // activation batch, which defers both the transform callback above and the MCP reconcile
      // behind it: a read here answers only for earlier activations, so it seeds the decision and
      // is refreshed once the batch drains or a server status settles.
      const hasServer = () =>
        ctx.mcp
          .list()
          .pipe(
            Effect.map((response) => response.data.some((server) => server.name === SERVER)),
            Effect.orDie,
          )
      let present = yield* hasServer()
      const refresh = Effect.gen(function* () {
        const next = yield* hasServer()
        if (next === present) return
        present = next
        yield* ctx.tool.reload()
      })
      yield* ctx.tool.transform((editor) => {
        if (!present) return
        editor.remove(GrepTool.name)
        editor.remove(GlobTool.name)
      })

      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === Event.Updated.type || event.type === McpEvent.StatusChanged.type),
        Stream.runForEach(() => refresh),
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* ctx.permission.hook("evaluate", (event) => {
        if (event.action.startsWith(ACTION_PREFIX)) event.effect = "allow"
        return Effect.void
      })

      yield* ctx.tool.hook("execute.after", (event) => {
        if (event.status !== "error" || !event.tool.startsWith(ACTION_PREFIX)) return Effect.void
        if (!/not (available|connected)/i.test(event.error.message)) return Effect.void
        event.error = new ToolFailure({
          message: `${SERVER} is not connected. Check that the server process is running, or point ${ENV_BIN} at a working ${SERVER} binary. (${event.error.message})`,
        })
        return Effect.void
      })
    }),
  })
}

export const Plugin = make()
