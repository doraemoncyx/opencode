export * as File from "./file"

import { Schema } from "effect"
import { NonNegativeInt, RelativePath } from "./schema"

export const Diff = Schema.Struct({
  path: RelativePath,
  status: Schema.Literals(["added", "modified", "deleted"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  patch: Schema.String,
}).annotate({ identifier: "File.Diff" })
export type Diff = typeof Diff.Type
