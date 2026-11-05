# Core MCP

`index.ts` owns the Location-scoped server entries, config reconciliation, permission-free catalogues, and the per-server lock. `connection.ts` owns one server's live client and the catalogues it listed; `client.ts` wraps the SDK.

## Idle release (fork feature)

- The idle policy lives entirely in `index.ts`: `releaseServer` decides when a process is reclaimed, `liveClient` restarts a released server under the server lock before any live use, and the reaper sweeps `entries` every `idleSweepInterval`. Upstream owns everything else in `index.ts`, so keep fork code as whole blocks (`LayerOptions`, `ServerEntry.idle`/`lastUsed`, the `releaseServer`/`restartReleased`/`liveClient` trio, the reaper before `Service.of`) rather than spreading it through upstream helpers.
- `connection.ts` keeps the retained catalogues (`instructions`, `catalogCache`) and the `release` effect that closes the process scope while leaving them intact. Add to that seam, do not reintroduce fork state into `index.ts`'s `ServerEntry`; `entry.connection.client` is the only live-process signal.
- `start` deliberately does not clear `prompts` on reconnect: a release keeps the last prompt list so `prompts()` never flashes empty while the server boots again.
- Three places carry a fork line inside upstream code on purpose, because the alternative is more of them: `connected` returns `liveClient` so every upstream caller inherits the lazy restart, `connecting` clears `entry.idle` (upstream replaced the `stopped` event with `changed`, which is not a start signal), and `ServerEntry.pooled` marks a connection `McpPool` shares. `McpPool`'s connection therefore implements `release` (`Effect.void` for a shared claim) plus the `instructions`/`catalogCache` getters that `Connection` requires.
- Pooled entries are never idle-released: `McpPool` closes the shared process when its last Location lets go, so `releaseServer` and the reaper both skip `entry.pooled`. A released pooled process would still look live to the other Locations holding that key.
