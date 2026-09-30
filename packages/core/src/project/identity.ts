export * as ProjectIdentity from "./identity.js"

import { Hash } from "@opencode/util/hash"
import { ID } from "./schema.js"

// Windows paths are case-insensitive; POSIX paths are not. A drive letter or UNC prefix
// marks the first kind, and the same rule has to hold for databases that move between
// operating systems.
const windowsDrive = /^[a-z]:[\\/]/i

/**
 * Markerless directories have no VCS identity, so their project id derives from the
 * directory itself. `realPath` returns the case the caller typed, so `f:\a` and `F:\A`
 * would otherwise become two projects for the same directory.
 */
export function normalize(directory: string) {
  if (!windowsDrive.test(directory) && !directory.startsWith("\\\\") && !directory.startsWith("//")) return directory
  return directory.replaceAll("\\", "/").toLowerCase()
}

export function fromDirectory(directory: string) {
  return ID.make(Hash.fast(`directory:${normalize(directory)}`))
}
