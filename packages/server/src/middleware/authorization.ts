import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Authorization } from "@opencode/protocol/middleware/authorization"
export { Authorization } from "@opencode/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(Effect.map((credential) => ServerAuth.authorized(credential, config)))
}

// Loopback requests are already authenticated when the embedder opts in. The CLI
// serves the web UI from this same listener, so a browser reaching it through
// 127.0.0.1 has no way to supply credentials of its own. Remote clients still
// authenticate. A missing peer address (embedded runtimes, tests) is never local.
export function localRequest(request: HttpServerRequest.HttpServerRequest) {
  return Option.exists(request.remoteAddress, isLoopbackAddress)
}

function isLoopbackAddress(address: string) {
  // Node reports IPv4 peers of a dual-stack listener as ::ffff:127.0.0.1.
  const host = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  return host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export const authorizationLayer = (localAuth: boolean) =>
  Layer.effect(
    Authorization,
    Effect.gen(function* () {
      const config = yield* ServerAuth.Config
      if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
      return Authorization.of((effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
          // credential checks here; the connect handler consumes and validates the ticket.
          const url = new URL(request.url, "http://localhost")
          if (hasPtyConnectTicketURL(url) || hasPersistentPtyConnectTicketURL(url)) return yield* effect
          if (localAuth && localRequest(request)) return yield* effect
          if (yield* authorizedRequest(request, config)) return yield* effect
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
          return yield* new UnauthorizedError({ message: "Authentication required" })
        }),
      )
    }),
  )
