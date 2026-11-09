import { Effect } from "effect"
import { decodeShellOutput } from "@opencode/util/encoding"

// Fork-only: paging for captured command output that may be GB18030. Kept out of `shell.ts` so an
// upstream rewrite of `Shell.output` needs at most a one-call adapter instead of a re-merge of this
// logic.

/** Reads up to `length` bytes from `start`; a missing or shorter file yields an empty/partial buffer. */
export type ReadRange = (start: number, length: number) => Effect.Effect<Buffer>

// GB18030 is not self-synchronizing: a page that starts inside a multi-byte character would decode
// misaligned. Page starts are therefore snapped back to a byte that cannot be a GBK trail byte (ASCII
// controls and DEL are single-byte in both UTF-8 and GBK).
const boundaryBefore = (read: ReadRange, start: number) =>
  Effect.gen(function* () {
    if (start <= 0) return 0
    const window = 64 * 1024
    let end = start
    while (true) {
      const from = Math.max(0, end - window)
      const bytes = yield* read(from, end - from)
      if (bytes.length === 0) return 0
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        const byte = bytes[index]!
        if (byte <= 0x3f || byte === 0x7f) return from + index
      }
      if (from === 0) return 0
      end = from
    }
  })

/**
 * One page of captured output, starting at `start` and covering at most `limit` bytes of a `size`-byte
 * file. The already-delivered prefix is dropped after decoding, and a few bytes past the page end
 * complete any character straddling it; the reported cursor never moves backwards.
 */
export const page = (read: ReadRange, start: number, size: number, limit: number) =>
  Effect.gen(function* () {
    if (limit <= 0) return { output: "", cursor: start }
    const from = yield* boundaryBefore(read, start)
    const bytes = yield* read(from, Math.min(size, start + limit + 4) - from)
    const decoded = decodeShellOutput(bytes, start - from)
    return { output: decoded.text, cursor: Math.max(start, from + decoded.consumed) }
  })
