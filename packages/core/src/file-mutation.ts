export * as FileMutation from "./file-mutation.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Bom } from "@opencode/util/bom"
import { decodeText, detectFileEncoding, encodeText, type FileEncoding } from "@opencode/util/encoding"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import type { FileAccess } from "./file-access.js"

export type Target = Pick<FileAccess.Target, "absolute" | "resource">

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
  /** String content is encoded with this encoding; defaults to utf-8. Ignored for Uint8Array content. */
  readonly encoding?: FileEncoding
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
  /** Encoding for the written bytes; defaults to utf-8. */
  readonly encoding?: FileEncoding
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
  /** Serialize a complete read/prepare/write mutation transaction by resolved path. */
  readonly withLock: (
    targets: ReadonlyArray<string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, Environment.WrongKind | Environment.Failed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  const bytes = (yield* files.read(target)).bytes
  const encoding = detectFileEncoding(bytes)
  // GB18030 文件按 gb18030 解码且没有 BOM 概念；UTF-8 仍走 Bom 以保留原有的去 BOM 行为。
  if (encoding === "gb18030") return { text: decodeText(bytes, "gb18030"), bom: false, encoding }
  return { ...Bom.decodeBytes(bytes), encoding }
})

export const syncTextBom = Effect.fn("FileMutation.syncTextBom")(function* (
  files: Files,
  target: string,
  bom: boolean,
) {
  const bytes = (yield* files.read(target)).bytes
  // 重新探测而非沿用调用方的编码：格式化器可能已按自己的编码重写文件。
  // GB18030 无 BOM，直接解码返回，绝不按 UTF-8 重新编码。
  if (detectFileEncoding(bytes) === "gb18030") return decodeText(bytes, "gb18030")
  const synced = Bom.syncBytes(bytes, bom)
  if (synced.bytes) yield* files.write(target, synced.bytes)
  return synced.text
})

/** Share transaction locks across Location graphs that address the same file. */
const transactionLocks = KeyedMutex.makeUnsafe<string>()

/**
 * Mutation locking is process-local and serializes cooperating OpenCode
 * changes; external writes can still race.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      [...new Set(targets.map(FSUtil.resolve))]
        .sort()
        .reduceRight((result, target) => transactionLocks.withLock(target)(result), effect)
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.absolute)(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* environment.files.stat(input.target.absolute).pipe(
            Effect.as(true),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* environment.files.write(
            input.target.absolute,
            typeof input.content === "string" ? encodeText(input.content, input.encoding ?? "utf-8") : input.content,
          )
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const encoding = input.encoding ?? "utf-8"
          const current = yield* environment.files.read(input.target.absolute, { offset: 0, length: 3 }).pipe(
            Effect.map((result) => result.bytes),
            Effect.catchTag("Environment.NotFound", () => Effect.undefined),
          )
          // GB18030 没有 BOM：先剥掉模型可能传入的前导 \uFEFF，再按 gb18030 写，否则会被编码成 '?'。
          if (encoding === "gb18030") {
            yield* environment.files.write(input.target.absolute, encodeText(Bom.split(input.content).text, "gb18030"))
            return writeResult(input.target, current !== undefined)
          }
          const next = Bom.split(input.content)
          yield* environment.files.write(
            input.target.absolute,
            encodeText(Bom.join(next.text, Boolean(current && Bom.has(current)) || next.bom), "utf-8"),
          )
          return writeResult(input.target, current !== undefined)
        }),
      ),
    )

    return Service.of({ withLock, write, writeTextPreservingBom })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })

/**
 * Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
