export * as BuiltInTools from "./builtins"

import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { ReadToolFileSystem } from "./read-filesystem"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"
import { ToolRegistry } from "./registry"
import { PermissionV2 } from "../permission"
import { Config } from "../config"
import { PluginBoot } from "../plugin/boot"
import { SkillV2 } from "../skill"
import { LocationMutation } from "../location-mutation"
import { FileMutation } from "../file-mutation"
import { QuestionV2 } from "../question"
import { SessionTodo } from "../session/todo"
import { Image } from "../image"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task, LSP,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
export const locationLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  QuestionTool.layer,
  ReadTool.layer.pipe(Layer.provide(ReadToolFileSystem.layer)),
  SkillTool.layer,
  TodoWriteTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
  WriteTool.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ToolRegistry.locationLayer,
      PermissionV2.locationLayer,
      Config.locationLayer,
      PluginBoot.locationLayer,
      SkillV2.locationLayer,
      LocationMutation.locationLayer,
      FileMutation.locationLayer,
      QuestionV2.locationLayer,
      SessionTodo.locationLayer,
      Image.locationLayer,
    ),
  ),
)
