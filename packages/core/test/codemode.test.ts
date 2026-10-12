import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { Effect, Schema } from "effect"
import type { Info } from "@opencode/schema/tool"
import { it } from "./lib/effect"

const toolNode = AppNodeBuilder.build(Tool.node, [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
])

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.namespace({ name: "empty", description: "No tools registered yet" })
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog).toStrictEqual({
        tools: [
          {
            type: "tool",
            name: "echo",
            description: "Echo text",
            signature: "tools.echo({\n  text: string,\n}): Promise<string>",
            pinned: true,
          },
          {
            type: "namespace",
            name: "empty",
            description: "No tools registered yet",
            tools: [],
          },
        ],
      })
    }).pipe(Effect.scoped, Effect.provide(toolNode)),
  )

  it.effect("renders Effect numbers in built-in tool signatures as number", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const ref = Schema.String.annotate({ identifier: "Ref", description: "Element ref" })
      const sentinel = Schema.Literals(["NaN", "Infinity", "-Infinity"])
      const Measure = {
        name: "measure",
        description: "Measure",
        input: Schema.Struct({ ref, amount: Schema.Number, sentinel }),
        output: Schema.Struct({ exit: Schema.optionalKey(Schema.Number), sentinel }),
        execute: () => Effect.succeed({ output: { exit: 0, sentinel: "NaN" as const } }),
      } satisfies Info<any, any>
      yield* tools.transform((editor) => {
        editor.add(Measure)
        editor.add({ ...Measure, name: "direct", options: { codemode: false } })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.codeModeCatalog?.tools).toEqual([
        {
          type: "tool",
          name: "measure",
          description: "Measure",
          signature: [
            "tools.measure({",
            "  /** Element ref */",
            "  ref: string,",
            "  amount: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}): Promise<{",
            "  exit?: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}>",
          ].join("\n"),
          pinned: false,
        },
      ])
      // Provider definitions keep Effect's plain JSON Schema encoding.
      const direct = JSON.stringify(snapshot.definitions.find((tool) => tool.name === "direct"))
      expect(direct).toContain('{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity","-Infinity","NaN"]}]}')
      expect(direct).not.toContain("$ref")
    }).pipe(Effect.scoped, Effect.provide(toolNode)),
  )

  it.effect("keeps direct tools out of the catalog and names the remedy inside execute", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({
          name: "webfetch",
          description: "Fetch a URL",
          input: Schema.Struct({ url: Schema.String }),
          output: Schema.String,
          options: { codemode: false },
          execute: ({ url }) => Effect.succeed({ output: url }),
        }),
      )

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["webfetch", "execute"])
      expect(snapshot.codeModeCatalog).toStrictEqual({ tools: [] })

      const result = yield* snapshot.execute({
        sessionID: Session.ID.make("ses_codemode"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_codemode"),
        call: {
          type: "tool-call",
          id: "call_execute",
          name: "execute",
          input: { code: "return await tools.webfetch({ url: 'https://example.com' })" },
        },
      })

      expect(result.content).toEqual([
        {
          type: "text",
          text: [
            "Unknown tool 'webfetch'.",
            "`webfetch` is not a Code Mode tool. Call it directly, outside `execute`.",
          ].join("\n"),
        },
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(Tool.node, [
          Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
        ]),
      ),
    ),
  )
})
