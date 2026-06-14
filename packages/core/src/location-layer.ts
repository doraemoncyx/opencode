import { Effect, Layer, LayerMap } from "effect"
import { Location } from "./location"
import { Policy } from "./policy"
import { Config } from "./config"
import { PluginV2 } from "./plugin"
import { Catalog } from "./catalog"
import { Integration } from "./integration"
import { CommandV2 } from "./command"
import { AgentV2 } from "./agent"
import { PluginBoot } from "./plugin/boot"
import { Project } from "./project"
import { ProjectCopy } from "./project/copy"
import { ProjectDirectories } from "./project/directories"
import { EventV2 } from "./event"
import { Credential } from "./credential"
import { Npm } from "./npm"
import { ModelsDev } from "./models-dev"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Database } from "./database/database"
import { PermissionV2 } from "./permission"
import { PermissionSaved } from "./permission/saved"
import { FileSystem } from "./filesystem"
import { Ripgrep } from "./ripgrep"
import { Watcher } from "./filesystem/watcher"
import { LocationMutation } from "./location-mutation"
import { FileMutation } from "./file-mutation"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import { RepositoryCache } from "./repository-cache"
import { Pty } from "./pty"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { BuiltInTools } from "./tool/builtins"
import { Image } from "./image"
import { ToolRegistry } from "./tool/registry"
import { ApplicationTools } from "./tool/application-tools"
import { ToolOutputStore } from "./tool-output-store"
import { AppProcess } from "./process"
import { SessionStore } from "./session/store"
import { SessionTodo } from "./session/todo"
import { QuestionV2 } from "./question"
import { LLMClient } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { Snapshot } from "./snapshot"
import { FetchHttpClient } from "effect/unstable/http"

export class LocationServiceMap extends LayerMap.Service<LocationServiceMap>()("@opencode/example/LocationServiceMap", {
  lookup: (ref: Location.Ref) => {
    const boot = Layer.effectDiscard(
      Effect.logInfo("booting location services", { directory: ref.directory, workspaceID: ref.workspaceID }),
    )
    const location = Location.layer(ref)
    return Layer.mergeAll(
      boot,
      Policy.locationLayer,
      Config.locationLayer,
      Reference.locationLayer,
      PluginV2.locationLayer,
      Catalog.locationLayer,
      Integration.locationLayer,
      CommandV2.locationLayer,
      AgentV2.locationLayer,
      PluginBoot.locationLayer,
      ProjectCopy.locationLayer,
      FileSystem.locationLayer,
      Watcher.locationLayer,
      Pty.locationLayer,
      SkillV2.locationLayer,
      SystemContextBuiltIns.locationLayer,
      LocationMutation.locationLayer,
      PermissionV2.locationLayer,
      ToolOutputStore.locationLayer,
      ToolRegistry.locationLayer,
      Snapshot.locationLayer,
      Image.locationLayer,
      FileMutation.locationLayer,
      SkillGuidance.locationLayer,
      ReferenceGuidance.locationLayer,
      SessionTodo.locationLayer,
      QuestionV2.locationLayer,
      SessionRunnerModel.locationLayer,
      SessionRunnerLLM.locationLayer,
      BuiltInTools.locationLayer,
    ).pipe(Layer.provideMerge(location), Layer.fresh)
  },
  idleTimeToLive: "60 minutes",
  dependencies: [
    Project.defaultLayer,
    EventV2.defaultLayer,
    Credential.defaultLayer,
    Npm.defaultLayer,
    ModelsDev.defaultLayer,
    FSUtil.defaultLayer,
    Git.defaultLayer,
    AppProcess.defaultLayer,
    Global.defaultLayer,
    Ripgrep.defaultLayer,
    Database.defaultLayer,
    ProjectDirectories.defaultLayer,
    SessionStore.defaultLayer,
    PermissionSaved.defaultLayer,
    RepositoryCache.defaultLayer,
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
    FetchHttpClient.layer,
    ToolOutputStore.defaultCleanupLayer,
    ApplicationTools.layer,
  ],
}) {}
