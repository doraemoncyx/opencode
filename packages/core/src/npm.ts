export * as Npm from "./npm"

import path from "path"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"
import { LayerNode } from "./effect/layer-node"
import { makeRuntime } from "./effect/runtime"

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
}

export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

const resolveEntryPoint = (name: string, dir: string): EntryPoint => {
  let entrypoint: string | undefined
  try {
    entrypoint = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
  } catch {
    entrypoint = undefined
  }
  return {
    directory: dir,
    entrypoint,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const initPkgJson = (dir: string) =>
      Effect.gen(function* () {
        const pj = path.join(dir, "package.json")
        if (!(yield* afs.existsSafe(pj))) {
          yield* fs.writeFile(pj, JSON.stringify({ private: true }))
        }
      })
    const reify = (input: { dir: string; add?: string[] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const add = input.add ?? []
        yield* initPkgJson(input.dir)
        const { spawn } = yield* Effect.promise(() => import("child_process"))
        yield* Effect.async<void, InstallFailedError>((resume) => {
          const child = spawn(
            "npm",
            ["install", ...add, "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline"],
            { cwd: input.dir, stdio: "ignore", env: { ...process.env } },
          )
          child.on("error", (err) =>
            resume(Effect.fail(new InstallFailedError({ cause: err, add, dir: input.dir }))),
          )
          child.on("close", (code) => {
            if (code === 0) resume(Effect.succeed(undefined))
            else resume(Effect.fail(new InstallFailedError({ add, dir: input.dir })))
          })
        })
      }).pipe(Effect.withSpan("Npm.reify", { attributes: input }))

    const add = Effect.fn("Npm.add")(function* (pkg: string) {
      const dir = directory(pkg)
      const name = (() => {
        try {
          return npa(pkg).name ?? pkg
        } catch {
          return pkg
        }
      })()

      if (yield* afs.existsSafe(path.join(dir, "node_modules", name))) {
        return resolveEntryPoint(name, path.join(dir, "node_modules", name))
      }

      yield* reify({ dir, add: [pkg] })
      const result = resolveEntryPoint(name, path.join(dir, "node_modules", name))
      if (result.entrypoint) return result
      return yield* new InstallFailedError({ add: [pkg], dir })
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return

      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = yield* afs.readJson(path.join(dir, "package.json")).pipe(Effect.orElseSucceed(() => ({})))
        const lock = yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => ({})))

        const pkgAny = pkg as any
        const lockAny = lock as any
        const declared = new Set([
          ...Object.keys(pkgAny?.dependencies || {}),
          ...Object.keys(pkgAny?.devDependencies || {}),
          ...Object.keys(pkgAny?.peerDependencies || {}),
          ...Object.keys(pkgAny?.optionalDependencies || {}),
          ...(input?.add || []).map((pkg) => pkg.name),
        ])

        const root = lockAny?.packages?.[""] || {}
        const locked = new Set([
          ...Object.keys(root?.dependencies || {}),
          ...Object.keys(root?.devDependencies || {}),
          ...Object.keys(root?.peerDependencies || {}),
          ...Object.keys(root?.optionalDependencies || {}),
        ])

        for (const name of declared) {
          if (!locked.has(name)) {
            yield* reify({ dir, add })
            return
          }
        }
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs.readDirectory(binDir).pipe(Effect.catch(() => Effect.succeed([] as string[])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(Effect.option)

        if (Option.isSome(pkgJson)) {
          const parsed = pkgJson.value as { bin?: string | Record<string, string> }
          if (parsed?.bin) {
            const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
            const parsedBin = parsed.bin
            if (typeof parsedBin === "string") return Option.some(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return Option.some(keys[0])
            return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
          }
        }

        return Option.some(files[0])
      })

      return Option.getOrUndefined(
        yield* Effect.gen(function* () {
          const bin = yield* pick()
          if (Option.isSome(bin)) {
            return Option.some(path.join(binDir, bin.value))
          }

          yield* fs.remove(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => {}))

          yield* add(pkg)

          const resolved = yield* pick()
          if (Option.isNone(resolved)) return Option.none<string>()
          return Option.some(path.join(binDir, resolved.value))
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
    })

    return Service.of({
      add,
      install,
      which,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, filesystem, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, LayerNode.compile(node))

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  return runPromise((svc) => svc.add(...args))
}

export async function which(...args: Parameters<Interface["which"]>) {
  return runPromise((svc) => svc.which(...args))
}
