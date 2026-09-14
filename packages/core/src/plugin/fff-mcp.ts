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

const GREP_GUIDANCE =
  "For content search in non-UTF-8 files (for example GBK-encoded text) or to match several alternative patterns in one call, use `fff-mcp_grep` (or `fff-mcp_multi_grep` for OR patterns) instead."
const GLOB_GUIDANCE = "For fuzzy file-name search, use `fff-mcp_find_files` instead."

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

      yield* ctx.tool.transform((editor) => {
        editor.update(GrepTool.name, (tool) => {
          if (tool.description.includes(GREP_GUIDANCE)) return
          tool.description = `${tool.description}\n\n${GREP_GUIDANCE}`
        })
        editor.update(GlobTool.name, (tool) => {
          if (tool.description.includes(GLOB_GUIDANCE)) return
          tool.description = `${tool.description}\n\n${GLOB_GUIDANCE}`
        })
      })

      yield* ctx.permission.hook("evaluate", (event) => {
        if (event.action.startsWith(ACTION_PREFIX)) event.effect = "allow"
        return Effect.void
      })

      yield* ctx.tool.hook("execute.after", (event) => {
        if (event.status !== "error" || !event.tool.startsWith(ACTION_PREFIX)) return Effect.void
        if (!/not (available|connected)/i.test(event.error.message)) return Effect.void
        event.error = new ToolFailure({
          message: `${SERVER} is not connected. Fall back to the built-in ${GrepTool.name}/${GlobTool.name} tools. (${event.error.message})`,
        })
        return Effect.void
      })
    }),
  })
}

export const Plugin = make()
