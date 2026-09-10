import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // Graceful shutdown: close the listener (and force-close active SSE /
    // WebSocket connections via stop(true)) instead of leaving orphaned
    // sockets in the kernel's TCP table when the process is interrupted.
    // stop(true) is wrapped in a timeout so a stuck force-close can never
    // prevent the process from exiting — otherwise a lingering CLOSE_WAIT /
    // LISTENING socket keeps the port busy (EADDRINUSE) after the process is
    // supposed to be gone.
    const shutdown = () => {
      void server
        .stop(true)
        .catch(() => undefined)
        .finally(() => process.exit(0))
      // Hard deadline: if stop(true) hasn't settled in 3s, exit anyway so the
      // port is released by the OS rather than stranded on a hung shutdown.
      setTimeout(() => process.exit(0), 3_000).unref()
    }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    process.once("SIGHUP", shutdown)

    yield* Effect.never
  }),
})
