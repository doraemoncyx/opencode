export * as FileMutation from "./file-mutation.js"

import { isUtf8 } from "node:buffer"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Bom } from "@opencode/util/bom"
import { decodeText, detectFileEncoding, encodeText, type FileEncoding } from "@opencode/util/encoding"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import { FileAccess } from "./file-access.js"
import { AbsolutePath } from "./schema.js"

export type Target = Pick<FileAccess.Target, "absolute" | "resource" | "environment">

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

export interface TextWriteResult extends WriteResult {
  readonly bom: boolean
}

export interface Interface {
  /**
   * Serialize a complete read/prepare/write mutation transaction by file. A typed path is located first, so it
   * names its machine when the text does.
   */
  readonly withLock: (
    targets: ReadonlyArray<Environment.Place | string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Environment.Failed, R>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Add bytes to the end of a file, creating it when missing. */
  readonly append: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<TextWriteResult, Environment.WrongKind | Environment.Failed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

const decodeFile = (bytes: Uint8Array) => {
  const encoding = detectFileEncoding(bytes)
  // GB18030 文件按 gb18030 解码且没有 BOM 概念；UTF-8 仍走 Bom 以保留原有的去 BOM 行为。
  if (encoding === "gb18030") return { text: decodeText(bytes, "gb18030"), bom: false, encoding }
  return { ...Bom.decodeBytes(bytes), encoding }
}

export class InvalidUtf8Error extends Schema.TaggedError<InvalidUtf8Error>()("FileMutation.InvalidUtf8Error", {
  path: Schema.String,
}) {
  override get message() {
    return "file is not valid UTF-8. It was left unchanged because rewriting it as text would replace every byte that is not UTF-8 with U+FFFD; change it with a tool that preserves its bytes, or convert it to UTF-8 first"
  }
}

export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  return decodeFile((yield* files.read(target)).bytes)
})

/** Read text that will be rewritten. Decoding replaces invalid bytes with U+FFFD, so such files are refused. */
export const readEditableText = Effect.fn("FileMutation.readEditableText")(function* (files: Files, target: string) {
  const bytes = (yield* files.read(target)).bytes
  const decoded = decodeFile(bytes)
  // GB18030 文件也按文本处理；只有连目标编码都无法无损解码的字节才拒绝。
  if (!isUtf8(bytes) && decoded.text.includes("\uFFFD")) return yield* new InvalidUtf8Error({ path: target })
  return decoded
})

export const readOptionalText = Effect.fn("FileMutation.readOptionalText")(function* (files: Files, target: string) {
  const result = yield* files.read(target).pipe(Effect.catchTag("Environment.NotFound", () => Effect.undefined))
  return result ? decodeFile(result.bytes) : undefined
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
    const access = yield* FileAccess.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      Effect.gen(function* () {
        const places = yield* Effect.forEach(targets, (target) =>
          typeof target === "string" ? access.locate(target) : Effect.succeed(target),
        )
        return yield* [
          ...new Set(
            places.map((target) =>
              FileAccess.key({
                absolute: AbsolutePath.make(FSUtil.resolve(target.absolute)),
                environment: target.environment,
              }),
            ),
          ),
        ]
          .sort()
          .reduceRight((result, file) => transactionLocks.withLock(file)(result), effect)
      })
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(FileAccess.key(target))(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    const put = (input: WriteInput, store: "write" | "append") =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* input.target.environment.files.stat(input.target.absolute).pipe(
            Effect.as(true),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* input.target.environment.files[store](
            input.target.absolute,
            typeof input.content === "string" ? encodeText(input.content, input.encoding ?? "utf-8") : input.content,
          )
          return writeResult(input.target, existed)
        }),
      )

    const write = Effect.fn("FileMutation.write")((input: WriteInput) => put(input, "write"))

    const append = Effect.fn("FileMutation.append")((input: WriteInput) => put(input, "append"))

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const encoding = input.encoding ?? "utf-8"
          const next = Bom.split(input.content)
          const current = yield* input.target.environment.files
            .read(input.target.absolute, { offset: 0, length: 3 })
            .pipe(
              Effect.map((result) => result.bytes),
              Effect.catchTag("Environment.NotFound", () => Effect.undefined),
            )
          // GB18030 没有 BOM：Bom.split 已剥掉模型可能传入的前导 \uFEFF，再按 gb18030 写，否则会被编码成 '?'。
          if (encoding === "gb18030") {
            yield* input.target.environment.files.write(input.target.absolute, encodeText(next.text, "gb18030"))
            return { ...writeResult(input.target, current !== undefined), bom: false }
          }
          const bom = Boolean(current && Bom.has(current)) || next.bom
          yield* input.target.environment.files.write(
            input.target.absolute,
            new TextEncoder().encode(Bom.join(next.text, bom)),
          )
          return { ...writeResult(input.target, current !== undefined), bom }
        }),
      ),
    )

    return Service.of({ withLock, write, append, writeTextPreservingBom })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FileAccess.node] })

/**
 * Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
