import { Effect } from "effect"
import { decodeShellOutput } from "@opencode/util/encoding"

// Fork-only: paging and tail decoding for captured command output that may be GB18030. Kept out of
// `shell.ts` so an upstream rewrite of `Shell.output` needs at most a one-call adapter instead of a
// re-merge of this logic.

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

// Moves past UTF-8 continuation bytes (at most 3) so a byte cut never splits a character.
const boundaryAfter = (bytes: Uint8Array, offset: number) => {
  const limit = Math.min(bytes.length, offset + 3)
  for (let index = offset; index < limit; index++) if ((bytes[index]! & 0xc0) !== 0x80) return index
  return limit
}

/** A captured window decoded line by line, from the character boundary at or after `start`. */
export const decodeWindow = (bytes: Uint8Array, start: number) =>
  decodeShellOutput(bytes.subarray(boundaryAfter(bytes, start))).text

/**
 * One page of captured output, starting at `start` and covering at most `limit` bytes of a `size`-byte
 * file. The already-delivered prefix is dropped after decoding, and a few bytes past the page end
 * complete any character straddling it; the reported cursor never moves backwards. A running command
 * holds a character cut off at the current end for the next page; an ended one decodes it now, since no
 * later page will complete it.
 */
export const outputPage = (read: ReadRange, start: number, size: number, limit: number, running: boolean) =>
  Effect.gen(function* () {
    if (limit <= 0) return { output: "", cursor: start }
    const from = yield* boundaryBefore(read, start)
    const bytes = yield* read(from, Math.min(size, start + limit + 4) - from)
    const finalized = !running && from + bytes.length >= size
    const decoded = decodeShellOutput(bytes, start - from, finalized)
    return { output: decoded.text, cursor: Math.max(start, from + decoded.consumed) }
  })
