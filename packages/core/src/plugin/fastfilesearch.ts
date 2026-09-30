export * as FastfilesearchPlugin from "./fastfilesearch.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Event } from "@opencode/schema/plugin"
import { Effect, Stream } from "effect"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { which } from "../util/which.js"

const SERVER = "fastfilesearch"
// The server is named `fastfilesearch`, while the binary it runs keeps the upstream `fff-mcp` name.
const BIN = "fff-mcp"
const ACTION_PREFIX = `${SERVER}_`
const ENV_BIN = "OPENCODE_FFF_MCP_BIN"

export function make(env: NodeJS.ProcessEnv = process.env) {
  return define({
    id: "opencode.fastfilesearch",
    effect: Effect.fn("FastfilesearchPlugin")(function* (ctx) {
      const command = env[ENV_BIN]?.trim() || which(BIN, env)

      yield* ctx.mcp.transform((editor) => {
        // This built-in runs after config-level MCP registration, so it upgrades the command of a
        // `fastfilesearch` server the user declared (for example a wrapper script) to the resolved
        // GBK-capable binary, leaving every other configured setting in place. A server that was not
        // declared is never added, so `fastfilesearch` participates only through `mcp` configuration.
        const existing = editor.get(SERVER)
        if (!existing || existing.type !== "local" || !command) return
        editor.set(SERVER, { ...existing, command: [command], codemode: false })
      })

      // The built-in search tools are only the fallback for when fastfilesearch is absent, so they are
      // removed whenever the effective server set contains it. Plugin setup runs inside the
      // activation batch, which defers both the transform callback above and the MCP reconcile
      // behind it: a read here answers only for earlier activations, so it seeds the decision and
      // is refreshed once the batch drains or a server status settles. A disabled server provides
      // nothing, so it keeps the fallback.
      const hasServer = () =>
        ctx.mcp
          .list()
          .pipe(
            Effect.map((response) =>
              response.data.some((server) => server.name === SERVER && server.status.status !== "disabled"),
            ),
            Effect.orDie,
          )
      let present = yield* hasServer()
      let warned = false
      const refresh = Effect.gen(function* () {
        const next = yield* hasServer()
        if (next && !warned && command === undefined) {
          warned = true
          yield* Effect.logWarning(
            `${SERVER} is configured without a resolvable ${BIN} binary; it keeps its configured command. Install ${BIN} on PATH or set ${ENV_BIN} to use the GBK-aware build.`,
          )
        }
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
          message: `${SERVER} is not connected. Check that the server process is running, or point ${ENV_BIN} at a working ${BIN} binary. (${event.error.message})`,
        })
        return Effect.void
      })
    }),
  })
}

export const Plugin = make()
