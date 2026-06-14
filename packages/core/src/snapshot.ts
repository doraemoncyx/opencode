export * as Snapshot from "./snapshot"

import { Context, Effect, Schema } from "effect"
import { File } from "./file"
import { RelativePath } from "./schema"

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
  readonly capture: () => Effect.Effect<ID | undefined, Error>
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
