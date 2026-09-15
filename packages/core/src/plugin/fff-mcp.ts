export * as FffMcpPlugin from "./fff-mcp.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
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

      let registered = false
      yield* ctx.mcp.transform((editor) => {
        // This built-in runs after config-level MCP registration, so it overrides the command of a
        // configured `fff-mcp` server (for example a wrapper script) with the resolved GBK-capable
        // binary. When nothing was configured, register it by default; skip that auto-registration
        // under test (unless opted in via OPENCODE_FFF_MCP=1) so suites don't spawn the external
        // process, while still exercising the override path.
        const auto = env.NODE_ENV !== "test" || env[ENV_AUTO] === "1"
        if (!editor.get(SERVER) && !auto) return
        editor.set(SERVER, { type: "local", command: [command], codemode: false })
        registered = true
      })

      // Built-in grep/glob remain only as a fallback for when fff-mcp was not registered: with a
      // connected server the two search tools are removed so models use the fff-mcp equivalents.
      if (registered)
        yield* ctx.tool.transform((editor) => {
          editor.remove(GrepTool.name)
          editor.remove(GlobTool.name)
        })

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
