export * as Snapshot from "./snapshot"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath, RelativePath } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /** Capture the current Location-scoped state. */
  readonly capture: () => Effect.Effect<ID | undefined>
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.project.id))

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(location.project.directory, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repository = Effect.fnUntraced(function* () {
      const source = yield* git.repo.discover(location.project.directory)
      if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
      if (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
        return new Git.Repository({
          worktree: location.project.directory,
          gitDirectory,
          commonDirectory: gitDirectory,
        })
      return yield* git.repo.create({
        worktree: location.project.directory,
        gitDirectory,
        seed: source,
      }).pipe(Effect.mapError((cause) => failure("capture", cause)))
    })

    const enabled = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return false
      return Config.latest(yield* config.entries(), "snapshots") !== false
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: yield* git.repo.discover(location.project.directory),
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined)),
        ),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { repository: repo, from: Git.TreeID.make(input.from), to: Git.TreeID.make(input.to) }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      return yield* git.tree
        .files(yield* compare("files", input))
        .pipe(Effect.mapError((cause) => failure("files", cause)))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      return yield* git.tree
        .diff({ ...(yield* compare("diff", input)), context: input.context })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(location.project.directory, file)
        if (!FSUtil.contains(location.project.directory, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const ignores = yield* git.repo.discover(location.project.directory)
      const current = yield* git.tree.capture({
        repository: repo,
        scopes: Array.from(files.keys()),
        ignores,
        maximumUntrackedFileBytes: 2 * 1024 * 1024,
      }).pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ capture, files, diff, preview, restore })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
