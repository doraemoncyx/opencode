import { expect } from "bun:test"
import { createConnection, type Socket } from "node:net"
import { Effect, Exit, Scope } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("authenticates API and frontend requests while allowing browser preflight", () =>
  Effect.gen(function* () {
    const fallback = "fallback".repeat(256)
    const server = yield* ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        cors: ["http://192.168.1.10:3001", "https://example.com"],
        app: { version: "test-version" },
        database: { path: ":memory:" },
      },
      undefined,
      (api) =>
        api.pipe(
          Effect.catchIf(
            (error) => error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.raw(fallback, { contentType: "text/plain" })),
          ),
        ),
    )
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/status", HttpServer.formatAddress(server.address)), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

    const status = yield* Effect.promise(() =>
      fetch(new URL("/api/status", HttpServer.formatAddress(server.address)), {
        headers: {
          authorization: `Basic ${btoa("opencode:secret")}`,
          origin: "http://localhost:3000",
        },
      }),
    )

    expect(status.status).toBe(200)
    expect(status.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ version: "test-version" })

    yield* Effect.forEach(
      ["http://192.168.1.10:3001", "https://example.com", "https://untrusted.example.com"],
      (origin) =>
        Effect.gen(function* () {
          const allowed = origin === "https://untrusted.example.com" ? null : origin
          const preflight = yield* Effect.promise(() =>
            fetch(new URL("/api/status", HttpServer.formatAddress(server.address)), {
              method: "OPTIONS",
              headers: {
                origin,
                "access-control-request-method": "GET",
                "access-control-request-headers": "authorization",
              },
            }),
          )
          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed)

          const status = yield* Effect.promise(() =>
            fetch(new URL("/api/status", HttpServer.formatAddress(server.address)), {
              headers: { origin, authorization: `Basic ${btoa("opencode:secret")}` },
            }),
          )
          expect(status.status).toBe(200)
          expect(status.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => status.arrayBuffer())

          const denied = yield* Effect.promise(() =>
            fetch(new URL("/api/status", HttpServer.formatAddress(server.address)), { headers: { origin } }),
          )
          expect(denied.status).toBe(401)
          expect(denied.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => denied.arrayBuffer())
        }),
    )

    const event = yield* Effect.promise(() =>
      fetch(new URL("/api/event", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(event.status).toBe(200)
    expect(event.headers.get("content-encoding")).toBeNull()
    const body = event.body
    if (!body) return yield* Effect.die(new Error("Event response has no body"))
    const reader = body.getReader()
    yield* Effect.promise(() => readUntil(reader, "server.connected"))
    yield* server.updateAvailable("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.update-available"))
    yield* server.updated("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.updated"))
    yield* Effect.promise(() => reader.cancel())

    const missing = yield* Effect.promise(() =>
      fetch(new URL("/missing", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(missing.status).toBe(200)
    expect(missing.headers.get("content-encoding")).toBe("br")
    expect(missing.headers.get("content-type")).toBe("text/plain")
    expect(missing.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(yield* Effect.promise(() => missing.text())).toBe(fallback)

    yield* Effect.forEach(["/api", "/api/missing", "/openapi.json"], (pathname) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL(pathname, HttpServer.formatAddress(server.address))))
        expect(response.status).toBe(401)
        expect(yield* Effect.promise(() => response.text())).toBe("")
      }),
    )

    yield* Effect.forEach(["/", "/workspace/example", "/_assets/app.js", "/icons/icon.svg", "/sw.js"], (pathname) =>
      Effect.gen(function* () {
        yield* Effect.forEach(["GET", "HEAD"], (method) =>
          Effect.gen(function* () {
            yield* Effect.forEach([undefined, `Basic ${btoa("opencode:wrong")}`], (authorization) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() =>
                  fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                    method,
                    headers: authorization ? { authorization } : undefined,
                  }),
                )
                expect(response.status).toBe(401)
                expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
                expect(yield* Effect.promise(() => response.text())).toBe("")
              }),
            )
            const response = yield* Effect.promise(() =>
              fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                method,
                headers: { authorization: `Basic ${btoa("opencode:secret")}` },
              }),
            )
            expect(response.status).toBe(200)
            expect(yield* Effect.promise(() => response.text())).toBe(method === "HEAD" ? "" : fallback)
          }),
        )
      }),
    )
  }),
)

// Idle keep-alive connections are dropped, and an upgraded WebSocket socket is
// force-closed on shutdown, so the listener port can be rebound immediately.
it.live(
  "reclaims idle connections and force-closes upgraded sockets so the port can be rebound",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const firstScope = yield* Scope.fork(scope)
      const captured: Array<{ keepAliveTimeout: number; headersTimeout: number }> = []
      const upgradedReady: Array<boolean> = []
      const first = yield* ServerProcess.start<never, never>(
        {
          hostname: "127.0.0.1",
          port: 0,
          password: "secret",
          app: { version: "test-version" },
          database: { path: ":memory:" },
        },
        undefined,
        (api) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const server = (
              request.source as {
                socket?: { server?: { keepAliveTimeout: number; headersTimeout: number } }
              }
            ).socket?.server
            if (server)
              captured.push({ keepAliveTimeout: server.keepAliveTimeout, headersTimeout: server.headersTimeout })
            // A ticketed PTY connect URL skips auth because browsers cannot set
            // headers on a WebSocket handshake. The upgrade stays open until
            // forced shutdown destroys the underlying socket.
            if (new URL(request.url, "http://localhost").pathname === "/api/pty/test/connect") {
              const socket = yield* Effect.orDie(request.upgrade)
              upgradedReady.push(true)
              // The request fiber is uninterruptible, so drain the socket and let
              // it complete when shutdown closes the connection.
              yield* Effect.orDie(socket.run(() => Effect.void))
              return HttpServerResponse.empty()
            }
            return yield* api
          }),
      ).pipe(Effect.provideService(Scope.Scope, firstScope))

      const base = HttpServer.formatAddress(first.address)
      const port = new URL(base).port

      const socket = yield* openUpgrade(new URL(base), "/api/pty/test/connect?ticket=1")
      yield* waitFor(() => captured.length > 0 && upgradedReady.length > 0).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die(new Error("server never upgraded the connection")),
        }),
      )
      expect(captured.at(-1)).toEqual({ keepAliveTimeout: 5_000, headersTimeout: 10_000 })

      yield* Scope.close(firstScope, Exit.void).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.die(new Error("server shutdown did not settle")),
        }),
      )
      yield* waitFor(() => socket.destroyed).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.die(new Error("upgraded socket survived shutdown")),
        }),
      )

      const secondScope = yield* Scope.fork(scope)
      const second = yield* ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: Number(port),
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
      }).pipe(Effect.provideService(Scope.Scope, secondScope))
      expect(new URL(HttpServer.formatAddress(second.address)).port).toBe(port)
      yield* Scope.close(secondScope, Exit.void).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.die(new Error("second server shutdown did not settle")),
        }),
      )
    }),
  20_000,
)

// Opens a TCP connection that speaks enough of the HTTP Upgrade handshake for
// Node to emit `upgrade`. The socket is left open so shutdown must destroy it.
function openUpgrade(origin: URL, path: string) {
  return Effect.callback<Socket, Error>((resume) => {
    const socket = createConnection({ host: origin.hostname, port: Number(origin.port) })
    let settled = false
    socket.on("error", (error) => {
      if (settled) return
      settled = true
      resume(Effect.fail(error))
    })
    socket.once("connect", () => {
      settled = true
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${origin.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`,
          "",
          "",
        ].join("\r\n"),
      )
      resume(Effect.succeed(socket))
    })
    return Effect.sync(() => socket.destroy())
  })
}

const waitFor = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) yield* Effect.sleep("10 millis")
  })

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string) {
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error(`Event stream ended before ${expected}`)
    if (new TextDecoder().decode(next.value).includes(expected)) return
  }
}
