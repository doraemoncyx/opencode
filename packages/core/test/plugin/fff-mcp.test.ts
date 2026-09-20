import { describe, expect } from "bun:test"
import { ToolFailure } from "@opencode/ai"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { FffMcpPlugin } from "@opencode/core/plugin/fff-mcp"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import type { PermissionHooks } from "@opencode/plugin/effect/permission"
import type { ToolEditor, ToolHooks } from "@opencode/plugin/effect/tool"
import { ID } from "@opencode/schema/event"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { Mcp } from "@opencode/schema/mcp"
import { Event } from "@opencode/schema/plugin"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Layer, Stream, type Types } from "effect"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { it, testEffect } from "../lib/effect"
import { host } from "./host"

type MutableServer = Types.DeepMutable<Mcp.ServerConfig>
type PermissionEvent = PermissionHooks["evaluate"]

/** Runs the plugin against in-process fakes, returning the mutable domain state it touched. */
function run(
  input: {
    readonly env?: NodeJS.ProcessEnv
    readonly servers?: Record<string, MutableServer>
    readonly tools?: Record<string, { description: string }>
    /** Emitted to the plugin's event stream; simulates post-activation MCP updates. */
    readonly events?: ReadonlyArray<EventManifest.ServerEvent>
    /** Answers the first server read with an empty list, the way the activation batch does. */
    readonly stale?: boolean
  } = {},
) {
  const servers = input.servers ?? {}
  const tools = input.tools ?? {}
  const events = input.events ?? []
  const permission: Array<(event: PermissionEvent) => Effect.Effect<void>> = []
  const after: Array<(event: ToolHooks["execute.after"]) => Effect.Effect<void>> = []
  const toolTransforms: Array<(editor: ToolEditor) => void> = []
  let listReads = 0
  let reloads = 0
  const base = host()
  const toolEditor = (): ToolEditor => ({
    list: () => Object.entries(tools).map(([id, tool]) => ({ ...tool, id }) as unknown as Tool.Info & { id: string }),
    get: (id) => {
      const tool = tools[id]
      return tool && ({ ...tool, id } as unknown as Tool.Info & { id: string })
    },
    namespace: () => {},
    add: () => {},
    update: (id, update) => {
      const tool = tools[id]
      if (tool) update(tool as Types.Mutable<Tool.Info>)
    },
    remove: (id) => {
      delete tools[id]
    },
  })
  const effect = FffMcpPlugin.make(input.env).effect(
    host({
      mcp: {
        list: () =>
          Effect.sync(() => {
            listReads += 1
            const names = input.stale === true && listReads === 1 ? [] : Object.keys(servers)
            return {
              location: { directory: AbsolutePath.make("/workspace") },
              data: names.map((name): Mcp.Server => ({ name, status: { status: "pending" } })),
            }
          }),
        reload: () => Effect.die("unused mcp.reload"),
        transform: (transform) =>
          Effect.sync(() => {
            transform({
              list: () => Object.entries(servers),
              get: (name) => servers[name],
              set: (name, config) => {
                servers[name] = structuredClone(config) as MutableServer
              },
              update: (name, update) => {
                const server = servers[name]
                if (server) update(server)
              },
              remove: (name) => {
                delete servers[name]
              },
            })
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromIterable(events) },
      permission: {
        ...base.permission,
        hook: (name, callback) => {
          if (name === "evaluate") permission.push(callback as (event: PermissionEvent) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: (transform) =>
          Effect.sync(() => {
            toolTransforms.push(transform as (editor: ToolEditor) => void)
            transform(toolEditor())
            return { dispose: Effect.void }
          }),
        reload: () =>
          Effect.sync(() => {
            reloads += 1
            for (const transform of toolTransforms) transform(toolEditor())
          }),
        hook: (name, callback) => {
          if (name === "execute.after")
            after.push(callback as unknown as (event: ToolHooks["execute.after"]) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  )
  return { effect, servers, tools, permission, after, reloads: () => reloads }
}

describe("FffMcpPlugin registration", () => {
  it.effect("overrides a configured server of the same name and removes the built-in search tools", () =>
    Effect.gen(function* () {
      const command = "C:\\tools\\fff-mcp.exe"
      const result = run({
        env: { OPENCODE_FFF_MCP_BIN: command, NODE_ENV: "test" } as NodeJS.ProcessEnv,
        servers: { "fff-mcp": { type: "local", command: ["python", "wrapper.py"] } },
        tools: { grep: { description: "grep description" }, glob: { description: "glob description" } },
      })

      yield* result.effect

      expect(result.servers["fff-mcp"]).toEqual({ type: "local", command: [command], codemode: false })
      expect(result.tools["grep"]).toBeUndefined()
      expect(result.tools["glob"]).toBeUndefined()
      expect(result.permission).toHaveLength(1)
    }),
  )

  it.effect("registers by default and removes the built-in search tools", () =>
    Effect.gen(function* () {
      const command = "C:\\tools\\fff-mcp.exe"
      const result = run({
        env: { OPENCODE_FFF_MCP_BIN: command } as NodeJS.ProcessEnv,
        tools: { grep: { description: "grep description" }, glob: { description: "glob description" } },
      })

      yield* result.effect

      expect(result.servers["fff-mcp"]).toEqual({ type: "local", command: [command], codemode: false })
      expect(result.tools["grep"]).toBeUndefined()
      expect(result.tools["glob"]).toBeUndefined()
    }),
  )

  it.effect("keeps the built-in search tools when auto-registration is skipped", () =>
    Effect.gen(function* () {
      const result = run({
        env: { OPENCODE_FFF_MCP_BIN: "fff-mcp", NODE_ENV: "test" } as NodeJS.ProcessEnv,
        tools: { grep: { description: "grep description" }, glob: { description: "glob description" } },
      })

      yield* result.effect

      expect(result.servers).toEqual({})
      expect(result.tools["grep"]?.description).toBe("grep description")
      expect(result.tools["glob"]?.description).toBe("glob description")
    }),
  )

  it.effect("removes the built-in search tools once the server set materializes after setup", () =>
    Effect.gen(function* () {
      const command = "C:\\tools\\fff-mcp.exe"
      const result = run({
        env: { OPENCODE_FFF_MCP_BIN: command } as NodeJS.ProcessEnv,
        stale: true,
        servers: { "fff-mcp": { type: "local", command: [command] } },
        events: [{ id: ID.create(), type: Event.Updated.type, created: 0, data: {} }],
        tools: { grep: { description: "grep description" }, glob: { description: "glob description" } },
      })

      yield* result.effect

      // Setup runs inside the activation batch, so its read cannot see the server yet. The
      // post-activation update is what removes the fallback.
      for (let attempt = 0; attempt < 50 && result.reloads() === 0; attempt++) yield* Effect.yieldNow

      expect(result.reloads()).toBe(1)
      expect(result.tools["grep"]).toBeUndefined()
      expect(result.tools["glob"]).toBeUndefined()
    }),
  )

  it.effect("degrades without throwing when the executable is missing", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const result = run({
          env: { PATH: tmp.path, PATHEXT: process.env.PATHEXT },
          tools: { grep: { description: "grep description" }, glob: { description: "glob description" } },
        })

        yield* result.effect

        expect(result.servers).toEqual({})
        expect(result.tools["grep"]?.description).toBe("grep description")
        expect(result.tools["glob"]?.description).toBe("glob description")
        expect(result.permission).toHaveLength(0)
      }),
    ),
  )

  it.effect("reports a readable fallback when the server is not connected", () =>
    Effect.gen(function* () {
      const result = run({ env: { OPENCODE_FFF_MCP_BIN: "fff-mcp" } as NodeJS.ProcessEnv })
      yield* result.effect

      const hook = result.after[0]
      if (!hook) return yield* Effect.die("plugin did not register an execute.after hook")
      const event = {
        tool: "fff-mcp_grep",
        sessionID: Session.ID.make("ses_fff"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_fff"),
        id: Tool.CallID.make("call_fff"),
        input: {},
        status: "error" as const,
        error: new ToolFailure({ message: 'MCP server "fff-mcp" is not available' }),
      }
      yield* hook(event)

      expect(event.error.message).toContain("OPENCODE_FFF_MCP_BIN")
    }),
  )
})

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const itPermission = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      PluginHooks.node,
    ]),
    [Location.node.replace(current)],
  ),
)

describe("FffMcpPlugin permissions", () => {
  itPermission.effect("pre-approves fff-mcp actions but preserves a configured deny", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: Session.ID.make("ses_test"),
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          agent: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const hooks = yield* PluginHooks.Service
      const base = host()
      yield* FffMcpPlugin.make({ OPENCODE_FFF_MCP_BIN: "fff-mcp" }).effect(
        host({
          mcp: {
            list: () =>
              Effect.succeed({
                location: { directory: AbsolutePath.make("/project") },
                data: [],
              }),
            reload: () => Effect.void,
            transform: () => Effect.succeed({ dispose: Effect.void }),
          },
          permission: {
            ...base.permission,
            hook: (name, callback) => hooks.register("permission", name, callback),
          },
          tool: {
            transform: () => Effect.succeed({ dispose: Effect.void }),
            reload: () => Effect.void,
            hook: () => Effect.succeed({ dispose: Effect.void }),
          },
        }),
      )

      const service = yield* Permission.Service
      const ask = (action: string) => service.ask({ sessionID: Session.ID.make("ses_test"), action, resources: ["*"] })
      const agents = yield* Agent.Service
      const setRules = (rules: Permission.Ruleset) =>
        agents.transform((editor) =>
          editor.update(Agent.ID.make("test"), (agent) => {
            agent.permissions = [...rules]
          }),
        )

      yield* setRules([])
      expect((yield* ask("fff-mcp_grep")).effect).toBe("allow")
      expect((yield* ask("read")).effect).toBe("ask")

      yield* setRules([{ action: "fff-mcp_grep", resource: "*", effect: "deny" }])
      expect((yield* ask("fff-mcp_grep")).effect).toBe("deny")
    }),
  )
})
