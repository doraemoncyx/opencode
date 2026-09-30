# MCP process accumulation per Location (v2)

Research note. Read-only investigation; no source files were changed.

**Question.** A long-running `opencode2 serve --service` process holds several live
`fff-mcp.exe` children. Is this a leak, and what is the highest-leverage fix?

**Repository convention.** This repo has no `docs/` tree; cross-module design notes
live in [`specs/v2/`](../../specs/v2/README.md) and explicitly exclude actionable
work ("Put actionable work in GitHub issues"). There is no notes/research convention,
so this file is placed at the documented fallback path `docs/research/` (directory created).

---

## 1. Observation (real evidence)

Host: Windows, opencode `v2.0.3` (`opencode2.EXE --version`). Service process was
launched by the CLI as `serve --service --port 4097`
(`~/.local/share/opencode/log/opencode.log:32313`, run `c2fec0e2`).

Process table (`Get-CimInstance Win32_Process`, read-only):

| PID   | PPID  | Name          | Created             | CommandLine                                                     |
| ----- | ----- | ------------- | ------------------- | --------------------------------------------------------------- |
| 34536 | 36628 | opencode2.exe | 2026-09-30 10:30:18 | `e:\programfiles\bin\opencode2.EXE serve --service --port 4097` |
| 29764 | 34536 | fff-mcp.exe   | 2026-09-30 10:30:23 | `e:\programfiles\bin\fff-mcp.EXE`                               |
| 20420 | 34536 | fff-mcp.exe   | 2026-09-30 10:30:24 | `e:\programfiles\bin\fff-mcp.EXE`                               |
| 28624 | 34536 | fff-mcp.exe   | 2026-09-30 10:31:18 | `e:\programfiles\bin\fff-mcp.EXE`                               |

Each `fff-mcp.exe` also owns a `conhost.exe` child (console allocation), so three
servers cost six OS processes.

The same run booted exactly four Locations and connected `fastfilesearch` three
times — one per successful Location:

```
32506 02:30:20.685 location services booted  directory="C:\Users\cyxn2760"
32729 02:30:22.354 mcp connect failed       fastfilesearch directory="C:\Users\cyxn2760" (MCP error -32000: Connection closed)
32929 02:30:22.873 location services booted  directory="E:\studycode\python\python_misc_codingnet"
33308 02:30:23.067 location services booted  directory="E:\studycode\python\python_misc_codingnet\py3_test"
33521 02:30:24.082 mcp connected            fastfilesearch directory="E:\studycode\python\python_misc_codingnet"
33558 02:30:24.784 mcp connected            fastfilesearch directory="E:\studycode\python\python_misc_codingnet\py3_test"
33774 02:31:18.018 location services booted  directory="H:\code\js\opencode_v2_proj\opencode_v2"
33991 02:31:18.937 mcp connected            fastfilesearch directory="H:\code\js\opencode_v2_proj\opencode_v2"
```

The fourth Location (`C:\Users\cyxn2760`) failed to handshake; its scope was closed and
no process survived (`mcp/index.ts:592`). Live `fff-mcp` count (3) equals the number of
**successfully booted Locations**, not the number of configured servers, and not repeats
of one server.

The live set is queryable without the UI:

```powershell
Invoke-RestMethod http://127.0.0.1:4097/api/debug/location
# -> 4 objects: C:\Users\cyxn2760, E:\...\python_misc_codingnet,
#               E:\...\python_misc_codingnet\py3_test, H:\...\opencode_v2
```

`mcp.fastfilesearch` is the only local stdio server; the other five are remote HTTP
(`~/.config/opencode/opencode.json`), which is why only `fff-mcp` multiplies.

---

## 2. Lifecycle trace (Location → Mcp.Service → Scope → spawn)

1. **A Location is a compiled graph keyed by directory.** Requests resolve a
   `Location.Ref` from `x-opencode-directory` / `location[directory]` and provide the
   Location's services (`server/src/location.ts:39-47`, `:57-68`); session routes use
   the session's stored location (`server/src/middleware/session-location.ts:22-27`,
   implemented by `core/src/effect/app-node-builder.ts:8-20`).
2. **One cached instance per Location.** `LocationServiceMap` is an Effect `LayerMap`
   keyed by canonical `Location.Ref`, built on demand and retained with
   `idleTimeToLive: Duration.infinity` (`core/src/location-services.ts:21-53`). The map
   is a process-global service in the server graph (`core/src/location-service-map.ts:18`,
   wired at `server/src/routes.ts:69`). So _opening a project = first use of a new key =
   a fresh `Instance.layer(ref)` build_.
3. **`Mcp.node` is Location-scoped and part of that graph.** `Instance.graph` lists
   `Mcp.node` (`core/src/instance.ts:88`); `layer(ref)` compiles it and binds `Location`
   (`core/src/instance.ts:146-157`). `Mcp.node = makeLocationNode(...)`
   (`core/src/mcp/index.ts:910-918`), and `makeLocationNode` is the `location` tag
   (`util/src/effect/app-node.ts:12`). **`Mcp.Service` is therefore constructed once per
   Location, never shared across Locations.**
4. **Connections are forked off the Location scope.** `layer` captures
   `const root = yield* Effect.scope` (`core/src/mcp/index.ts:195`). `reconcile`
   registers entries and, for each enabled server, forks
   `startServer(name, entry)` asynchronously (`core/src/mcp/index.ts:660-683`).
5. **Each `startServer` opens a child scope and spawns inside it.**
   `const scope = yield* Scope.fork(root); entry.scope = scope`
   (`core/src/mcp/index.ts:556-557`); `McpClient.connect(...)` runs with
   `Scope.provide(scope)` (`core/src/mcp/index.ts:562-575`). For a local config,
   `client.ts:217-230` builds the stdio transport; `stdio.ts:44-101` calls
   `environment.spawner.spawn(ChildProcess.make(...))` with `cwd = config.cwd ?? directory`
   (`client.ts:224`) **inside the calling scope** — see the explicit comment at
   `stdio.ts:41-43`.
6. **Teardown is scope-driven, not refcounted.** `stopServer` closes `entry.scope`
   (`core/src/mcp/index.ts:606-617`); `Reconcile`'s diff path, `replaceServer`,
   `removeServer`, `disconnect`, `connect`, and the OAuth reconnect path are the only
   callers. `Scope.fork` semantics: "Closing the parent closes the child with the same
   exit value" (`effect-smol/packages/effect/src/Scope.ts:409`), so closing the Location
   scope kills every forked MCP scope; the spawner escalates `SIGTERM → SIGKILL` and, on
   Windows, runs `taskkill /pid <pid> /T /F` (`util/src/cross-spawn-spawner.ts:335-355`).
   The transport also does `client.close()` at `client.ts:262`.

**Net lifetime rule:** one local stdio process per `(Location × enabled local server)`,
alive from first use until the Location scope closes.

---

## 3. Root cause

**Not a leak in the usual sense, and not duplicate spawning.** MCP is _designed_
Location-scoped: one `Mcp.Service`, one stdio process, per distinct project directory.
The observed count is exactly "distinct projects opened recently", and the log shows a
single `mcp connected` per Location.

What _is_ missing is any bound tighter than Location eviction:

- **Locations are evicted only after 60 minutes of inactivity.** `LocationActivity`
  defaults to `timeToLive = 60 minutes`, swept every minute, and it only evicts when no
  session execution is active at that Location (`core/src/location-activity.ts:16-25`,
  `:42-85`, `:81`). Any durable session event at a Location refreshes its deadline.
  So live `fff-mcp` ≈ _projects touched in the last hour_, which is what a
  multi-project desktop/TUI session accumulates.
  **The 60-minute mechanism is healthy but does not bound steady-state process count**:
  in practice 98% of evictions are followed within 10 seconds by a boot of the _same_
  directory, so the child process is killed and immediately respawned — a restart, not a
  reclaim. See §7 for the measured evidence and a controlled live reproduction.
- **No cross-Location sharing.** Identical stateless commands (same binary, same args)
  are never deduplicated; each Location spawns its own.
- **No lazy-connect / idle-disconnect at the MCP layer.** `reconcile` connects every
  enabled server eagerly (`mcp/index.ts:674-681`); `McpTool` blocks on discovery
  (`tool/mcp.ts:37-40`), so the connection is required at Location boot.
- **Remote servers do not have this cost.** They open no local process
  (`client.ts:240-256`), so the accumulation is stdio-specific.

### Hypotheses checked

| Hypothesis                            | Verdict       | Evidence                                                                                                                                                |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 distinct Locations                  | **Confirmed** | 3 `location services booted` + 3 `mcp connected ... fastfilesearch` at 3 directories; `/api/debug/location` returns those plus the failed home Location |
| Repeat `startServer` on one Location  | Refuted       | `applied` guard short-circuits equal configs (`mcp/index.ts:657-698`); one connected log per directory                                                  |
| Config + built-in double registration | Refuted       | the built-in only upgrades an existing `fastfilesearch` entry, never adds one (`plugin/fastfilesearch.ts:24-32`, `plugin/internal.ts:232-235`)          |
| Failure-path process leak             | Refuted here  | failed Location's scope is closed (`mcp/index.ts:592`); no orphan `fff-mcp` for `C:\Users\cyxn2760`                                                     |

### What would settle any residual doubt

Capture **PID-level parentage** together with the per-connection `connectionID` (logged
at `mcp connected`, e.g. `4e375942-…`) and correlate each PID with the Location that
spawned it. Correlating `Win32_Process.ParentProcessId` with the debug-location list
already gives count parity (3 = 3); to attribute a PID to a directory, log the child PID
from `stdio.ts` at spawn time. Doing so would also prove there is no hidden same-Location
double start under a config-reload race (the lock in `mcp/index.ts:201-203` makes one
unlikely).

---

## 4. Idle reaping, refcounting, sharing — what already exists

| Mechanism                                | Present?                           | Where                                                                                              |
| ---------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Location idle TTL (60 min)               | Yes                                | `core/src/location-activity.ts:16-25`, `:78-81`                                                    |
| LayerMap idle TTL for Locations          | **Disabled** (`Duration.infinity`) | `core/src/location-services.ts:52`                                                                 |
| Explicit eviction endpoint               | Yes                                | `debug.location.evict`, `protocol/src/groups/debug.ts:19-31`, `server/src/handlers/debug.ts:16-23` |
| MCP-scoped idle disconnect               | No                                 | —                                                                                                  |
| Cross-Location dedup / sharing           | No                                 | —                                                                                                  |
| Refcount of MCP processes                | No                                 | —                                                                                                  |
| Non-stdio servers avoid the process cost | Yes                                | `client.ts:240-256`                                                                                |
| Config `disabled` per server             | Yes                                | `schema/src/mcp.ts:26`, honored at `mcp/index.ts:636-639`, `:675-679`                              |

`debug.location.evict` is real and already disposes a Location (closing its scope and
killing its MCP children): it calls `locations.invalidate(requestRef(...))`
(`handlers/debug.ts:22`), which runs `inner.invalidate(key)` and `build.close`
(`location-services.ts:59-67`). The missing piece is anything that _calls_ it on project
close / client disconnect, or an MCP-layer timer.

---

## 5. Optimization options (ranked by fit)

Ranked by leverage × design fit. Repo invariants come from `AGENTS.md`
("Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem
Location-scoped", and the `tool/AGENTS.md` rule "`Tool.Service` is Location-scoped.
Do not make the registry process-global"). MCP carries cwd/roots semantics for the
Location (`client.ts:197-199`, `:224`), which is the reason it is Location-scoped.

### (b) Lazy connect + MCP idle-disconnect — **recommended**

Give each `ServerEntry` an idle clock and disconnect a connected server after N minutes
without an MCP tool call, reconnecting on demand. Bound the _process_ count to "projects
that actually used MCP recently", independent of the 60-minute Location TTL.

- Touch: `core/src/mcp/index.ts` (`startServer`/`stopServer`, a reaper fiber, and a
  "connect on `callTool`/`tools()`" path), `core/src/tool/mcp.ts:37-40` (defer the
  discovery wait).
- Invariant fit: **good.** Keeps per-Location MCP and cwd correctness. Does not violate
  the Location-scoped rule; it only changes when a Location's server is live.
- Caveat: tool _schemas_ must still be known to the registry before execution; cache the
  discovered catalogue while disconnected, or keep `tools()` tolerant of a cold server.

### (c) Dedup identical stdio commands across Locations — **highest steady-state lever**

A process-global "shared stdio connection" keyed by `type+command+args+environment` for
servers declared scope-independent; refcount borrowers per Location.

- Touch: `core/src/mcp/index.ts` (a `makeGlobalNode` registry alongside the Location
  node; routing in `startServer`), `core/src/mcp/stdio.ts` (cwd becomes a tool arg
  rather than the spawn cwd), `schema/src/mcp.ts` (a `scope: "global"` flag).
- Invariant fit: **partial.** Deliberately breaks the "one server per Location" rule for
  opted-in servers. Safe only for stateless servers that do not depend on spawn cwd —
  in this repo exactly the built-in `fastfilesearch`/`fff-mcp`. Do this as an explicit
  config opt-in, not a default.

### (d) Lifecycle teardown on project close / client disconnect

Wire `debug.location.evict` (or a narrower "close this Location's MCP") into real client
signals — TUI tab close, session end, last connection for a directory.

- Touch: server-side new lifecycle hook plus `core/src/location-services.ts:59-67`;
  possibly reuse `LocationActivity`.
- Invariant fit: **good**, and it is the smallest change if a reliable "project closed"
  signal exists. Risk: the shared service has no per-project connection boundary today,
  so this may only shrink the TTL in practice.

### (a) Process-global singleton for stateless servers — **most invasive**

- Touch: `core/src/mcp/index.ts:910-918` (`makeLocationNode` → `makeGlobalNode`),
  `core/src/instance.ts`, `core/src/environment/environment.ts`.
- Invariant fit: **conflicts** with the Location-scoped rule and with cwd/roots
  (`client.ts:224`). Not recommended as a blanket change; prefer the opt-in form in (c).

### (e) Config knob to disable the built-in — **not applicable as stated**

`fastfilesearch` is already user-declared, not auto-added
(`plugin/fastfilesearch.ts:24-32`). The user already has the knob: set
`"disabled": true` on the server (`schema/src/mcp.ts:26`). This removes a process per
Location but forfeits the tool.

### Immediate, no-code mitigation

- `disabled: true` for any local server not needed in a given setup.
- Evict projects explicitly: `DELETE /api/debug/location?location[directory]=<dir>`.
  Caveat (§7.3): a project a client still references reboots within ~1 s, so this only
  shrinks the set for projects nothing polls.
- Lower `LocationActivity` TTL if a shorter idle bound is acceptable
  (`core/src/location-activity.ts:25`).

---

## 6. Verification

All commands are read-only except the explicit evict in step 3, which is a documented
debug endpoint. Run the service commands against the actual port (`--port 4097` above);
add `-Headers @{ Authorization = "Bearer $(opencode2 service get password)" }` when a
password is configured (the local server above answered without one).

**A. Reproduce the accumulation**

```powershell
# 1. Service PID (the parent of the fff-mcp children)
$svc = (Get-CimInstance Win32_Process -Filter "Name='opencode2.exe'" |
  Where-Object { $_.CommandLine -match '--service' }).ProcessId

# 2. Live local stdio MCP children, with spawn times
Get-CimInstance Win32_Process -Filter "Name='fff-mcp.exe'" |
  Where-Object { $_.ParentProcessId -eq $svc } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine |
  Sort-Object CreationDate

# 3. Currently loaded Locations (one per open project)
Invoke-RestMethod http://127.0.0.1:4097/api/debug/location

# 4. Open N distinct projects in the client, then re-run 2 and 3.
#    Expect: count(fff-mcp) == count(locations with a successful fastfilesearch connection).
```

**B. Confirm a Location's MCP processes are reclaimed on eviction**

```powershell
# Count before
(Get-CimInstance Win32_Process -Filter "Name='fff-mcp.exe'" |
  Where-Object { $_.ParentProcessId -eq $svc }).Count

Invoke-RestMethod -Method Delete `
  "http://127.0.0.1:4097/api/debug/location?location[directory]=E:\studycode\python\python_misc_codingnet"

# Allow up to ~2s for the spawner grace (CLOSE_GRACE/FORCE_KILL_AFTER in stdio.ts:12-15)
Start-Sleep 3

# Count after: should drop by the number of local servers that Location held
(Get-CimInstance Win32_Process -Filter "Name='fff-mcp.exe'" |
  Where-Object { $_.ParentProcessId -eq $svc }).Count
```

**C. Confirm a fix reduces live `fff-mcp` children**

Use the same before/after counter from B while exercising the changed behavior:

- For **(b)/(c)**: open several distinct projects, let them all connect once, then idle
  past the chosen MCP TTL (or the sharing path) and assert the live `fff-mcp` count for
  `$svc` is bounded by the number of _actively used_ projects rather than the number of
  loaded Locations. Cross-check `Invoke-RestMethod http://127.0.0.1:4097/api/debug/location`
  is unchanged while the process count falls.
- Also assert no orphan survives eviction: `tasklist /fi "imagename eq fff-mcp.exe"`
  should show none parented to `$svc` after eviction.
- Regression guard: open/close the same project repeatedly and confirm the count does not
  grow monotonically (this is the "repeat `startServer` without `stopServer`" check that
  the `applied` guard at `mcp/index.ts:657-698` is meant to prevent).

---

## 7. Follow-up: does the 60-minute idle eviction actually reclaim processes?

Measured against the rotated logs in `~/.local/share/opencode/log/` (9 files,
926 parsed boot/evict events) and one controlled live reproduction. Short answer:
**the reaper fires on time and does tear the Location down, but it almost never shrinks
the process set — it restarts it.**

### 7.1 The reaper is healthy and on time

| Metric                                                | Value                                                  |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Genuine `location services evicted` events            | **296** (across 15 server runs)                        |
| Runs that evicted at least one Location               | 15 (e.g. `40fde6dc` 115, `600fa79b` 38, `4a93df26` 29) |
| boot → evict gap, same run+directory                  | min 2.0 m, **median 61.0 m**, max 359.2 m              |
| Gaps in the 55–65 m band                              | 195 / 296                                              |
| Evictions followed by `watcher stopped` for that path | yes (scope is really closed)                           |

61 minutes = `timeToLive = 60 minutes` + the 1-minute sweep (`location-activity.ts:25`,
`:43`). So the mechanism is not broken; §3's claim that eviction is the only reclaim path
is still literally true, but it is misleading about _effect_.

### 7.2 But 98% of evictions are immediately undone

**289 of 296 evictions (98%) are followed within 10 seconds by a reboot of the same
directory.** A complete, logged example (run `d628e80a`, `opencode.log.5`):

```
12:25:34.438  location services evicted   directory="E:\...\python_misc_codingnet"
12:25:35.101  location services booted    directory="E:\...\python_misc_codingnet"
12:25:36.635  mcp connected fastfilesearch directory="E:\...\python_misc_codingnet"  connectionID=c72d195c...
```

The invalidate only detaches the cache entry; borrowers keep the old graph, and the next
request for that directory builds a fresh entry (`location-services.ts:64-66`,
`location-activity.ts:61-62`). A client that still references the directory reboots it at
once, so the count oscillates instead of falling.

### 7.3 Controlled live reproduction (2026-09-30)

Service `opencode2 serve --service --port 4097`, PID 34536. `py3_test` was a
**non-current** project, so this isolates eviction from active use:

```powershell
Invoke-RestMethod -Method Delete `
  "http://127.0.0.1:4097/api/debug/location?location%5Bdirectory%5D=E%3A%5Cstudycode%5Cpython%5Cpython_misc_codingnet%5Cpy3_test"
```

| t       | live `fff-mcp` children of 34536 | target PID 20420 |
| ------- | -------------------------------- | ---------------- |
| before  | 20420, 29764, 28624              | alive            |
| +0.5 s  | **7876**, 29764, 28624           | **dead**         |
| +1…15 s | 7876, 29764, 28624 (stable)      | dead             |

`20420` died in under a second and its `conhost.exe` child went with it — the kill path is
correct. But PID `7876` was spawned the same second, and the log shows a full reconnect:

```
02:43:19.385  location services booted  directory="E:\...\py3_test"
02:43:20.401  mcp connected fastfilesearch  directory="E:\...\py3_test"  connectionID=e5ee3ecd-...
```

`/api/debug/location` still lists `E:\...\py3_test` (it re-entered the cache). **Net
process count: unchanged.** Even a manual eviction of an idle project is undone, because
something (the client) re-references the directory within the same second.

Note: only the idle reaper logs `location services evicted` (`location-activity.ts:78`);
the `debug.location.evict` handler calls `locations.invalidate(...)` directly
(`server/src/handlers/debug.ts:22`) and emits no such line — which is why the current run
shows zero `evicted` lines despite this experiment.

### 7.4 A real amplifier: case-variant Location keys

`LocationServiceMap.canonical` only runs `path.normalize` and does **not** case-fold
(`location-service-map.ts:21-26`), so on Windows `H:\proj` and `h:\proj` are two distinct
Locations, each with its own MCP child. The logs contain **11** paths that appear in two
or three casings, e.g.:

```
['H:\code\xyq_projs_mono_repo\cyx260924msyautodev', 'h:\...\cyx260924msyautodev']
['H:\code\rust\fff', 'h:\code\rust\fff']
['G:\tmp', 'g:\TMP', 'g:\tmp']
```

Same-second double count observed: `07:34:30` booted both `h:\...\cyx260924msyautodev` and
`H:\...\cyx260924msyautodev`. Fix is a case-fold in `canonical` on win32.

### 7.5 Bearing on the options in §5

- Eviction is **not** an idle-reclaim signal you can lean on: it is re-entered within a
  second while any client still references the project. It also cannot fire while the
  project is in active use, which is exactly when you care about the process count.
- This strengthens **(b) MCP-scoped idle disconnect**: key its clock on _MCP tool calls_,
  not on Location activity, so a connected-but-idle server is dropped even while the
  Location stays hot, and reconnection is lazy rather than eager.
- It also makes **(c) process-global sharing** the only option that reduces the
  steady-state count for a set of simultaneously-open projects, because (b) alone cannot
  go below "one per project currently in use".

**Verification for this section** (read-only except the one evict):

```powershell
# reaper health: median boot->evict should be ~60 min
loc_evict.py   # parses all rotated logs; see companion script

# controlled eviction: target PID must change while the count stays the same
$svc = (Get-CimInstance Win32_Process -Filter "Name='opencode2.exe'" |
  Where-Object { $_.CommandLine -match '--service' }).ProcessId
Get-CimInstance Win32_Process -Filter "Name='fff-mcp.exe'" |
  Where-Object { $_.ParentProcessId -eq $svc } |
  Select-Object ProcessId, CreationDate | Sort-Object CreationDate
```

---

## 8. Implementation status (option b)

Shipped in `packages/core/src/mcp/index.ts`, tested in `packages/core/test/mcp.test.ts`
("releases an idle MCP server and reconnects lazily on the next live use").

- `ServerEntry` gains `lastUsed`, `idle`, and a cached `instructions`. A scoped reaper releases a
  connected server after `idleTimeout` (default 5 minutes, swept every 1 minute), keeping the cached
  tools/prompts/instructions so the tool registry and context assembly stay stable.
- `releaseServer` drops the process without clearing the catalogue; `callTool`/`prompt`/`readResource`/
  `resourceCatalog` reconnect through `acquireClient` under the server lock. `tools()`/`instructions()`/
  `prompts()` serve the cache and never start a process.
- Net effect: live stdio processes are bounded by "servers with a live interaction in the last
  `idleTimeout`", independent of the 60-minute Location TTL and its 98% churn (§7.2).

Deliberate scope limits (raised in review):

1. **First connect stays eager.** MCP tool discovery happens at Location boot, so a brand-new Location
   has no catalogue to serve while cold; true cold-start laziness would require persisting discovered
   tool schemas across restarts (not in scope). The win is bounded steady state, not zero boot cost.
2. **Release is transparent.** Status stays `connected` (logical availability, reconnect on demand)
   rather than adding a public `idle` status, which would be a wire-contract change.
3. **The idle clock counts live interactions**, not registry reads: `tools()` polling a hot Location
   cannot pin a process, while a prompt or resource read resets the timer.
4. `idleTimeout`/`idleSweepInterval` are `Mcp.layer` options today, not yet a config-file field.

---

## 9. Sources

**Repo (`path:line`)**

- `packages/core/src/mcp/index.ts:185-207` (layer, `root` scope, entries, lock), `:550-604`
  (`startServer`, `Scope.fork(root)`, `Scope.provide`, failure-path close), `:606-623`
  (`stopServer`/`disposeServer`), `:657-698` (`reconcile`, `applied` guard), `:910-918`
  (`configured`/`node` = `makeLocationNode`).
- `packages/core/src/mcp/stdio.ts:12-15` (grace constants), `:41-44` (calling-scope
  contract), `:82-101` (`environment.spawner.spawn`).
- `packages/core/src/mcp/client.ts:197-199` (roots), `:217-230` (local transport, `cwd`),
  `:240-256` (remote transport), `:258-262` (`client.close` finalizer).
- `packages/core/src/location-services.ts:21-53` (LayerMap, `idleTimeToLive: infinity`),
  `:59-67` (`invalidate`).
- `packages/core/src/location-activity.ts:16-25` (60 min TTL), `:42-85` (sweep),
  `:78-81` (`location services evicted` → invalidate).
- `packages/core/src/location-service-map.ts:9-18` (global service + node).
- `packages/core/src/instance.ts:88` (`Mcp.node`), `:146-157` (`layer(ref)` compile).
- `packages/core/src/effect/app-node-builder.ts:8-27` (`Instance.provide` → `locations.get`).
- `packages/core/src/plugin/fastfilesearch.ts:24-32` (upgrade-only registration),
  `packages/core/src/plugin/internal.ts:232-235` (post-config ordering).
- `packages/core/src/tool/mcp.ts:37-40` (tool discovery waits on connect), `:130-150`
  (reload on `ToolsChanged`).
- `packages/util/src/effect/app-node.ts:3-12` (`location`/`global` tags, `makeLocationNode`).
- `packages/util/src/cross-spawn-spawner.ts:340-355` (`taskkill /T /F`, process-group kill).
- `packages/server/src/location.ts:39-47`, `:57-68` (request → Location services).
- `packages/server/src/middleware/session-location.ts:22-27`; `middleware/form-location.ts:24-37`.
- `packages/server/src/routes.ts:69` (`LocationServiceMap.node`), `:70` (`LocationActivity.node`),
  `:135-142` (`Mcp.configured`).
- `packages/server/src/handlers/debug.ts:7-24`; `packages/protocol/src/groups/debug.ts:6-32`;
  `packages/protocol/src/groups/location.ts:5-26` (`LocationQuery` deepObject shape).
- `packages/schema/src/mcp.ts:26` (`disabled`); `packages/util/src/effect/layer-node.ts:218-223`
  (group only exposes children; global tag shared across Locations).
- `AGENTS.md` (Location-scoping invariant); `packages/core/src/tool/AGENTS.md`
  ("`Tool.Service` is Location-scoped").
- `specs/v2/README.md:1-40` (repo doc convention).
- Runtime evidence: `~/.local/share/opencode/log/opencode.log:32313`, `:32506`, `:32729`,
  `:32929`, `:33308`, `:33521`, `:33558`, `:33774`, `:33991`; process table for PIDs
  34536/29764/20420/28624. §7 adds: 9 rotated log files parsed (926 boot/evict events,
  296 evictions, 289 same-directory reboots ≤10 s, 11 case-variant paths); live experiment
  PIDs 20420 → 7876 at 2026-09-30 02:43:19–20 UTC.
- Companion script: `C:\cache\tmp\bin\loc_evict.py` (parses all rotated logs for reaper health,
  churn, and case-variant paths; read-only; callable by bare name).
- Effect scope semantics: `effect-smol/packages/effect/src/Scope.ts:405-442`
  ("Closing the parent closes the child").

**Upstream prior art (issue pages)**

- https://github.com/anomalyco/opencode/issues/26714 — "Local stdio MCP servers leak
  processes on disconnect / replace / rollback": confirms the _historical_ class of bug
  (client close ≠ process kill, orphans reparented) and that it applied to the legacy
  instance-teardown path. This repo's v2 has since moved to scope-owned spawning
  (`stdio.ts:41-43`), which is the fix direction this issue asked for. The issue's
  disconnect/replace paths here are covered by `stopServer`/`disposeServer`
  (`mcp/index.ts:606-623`). Contributes: the failure mode to check for (orphans) and the
  expected invariant.
- https://github.com/anomalyco/opencode/issues/41331 — "Desktop app spawns every local
  stdio MCP server twice at session start": v1 duplicate-spawn bug class. Contributes:
  proves the "N copies" symptom can be _duplicate spawns_ in v1, which this v2 evidence
  explicitly rules out (one connected log per Location).
- https://github.com/anomalyco/opencode/issues/6633 — "MCP processes not terminated after
  session ends" (closed by PR #15516): establishes that session end is the expected
  teardown trigger and that descendant cleanup was added then.
- https://github.com/anomalyco/opencode/issues/15808 — "`opencode run`: MCP child
  processes not terminated on exit": exit-path teardown.
- https://github.com/anomalyco/opencode/issues/46174 — "Windows Desktop starts duplicate
  MCP processes at idle" (open, assigns `Hona`): closest current report; multi-project
  restoration multiplies processes. Contributes: the multi-project/idle symptom matches
  this v2 per-Location behavior, and it remains unfixed upstream as of this writing.

No upstream PR was found that shares stateless MCP servers across projects or adds an
MCP-layer idle disconnect; prior art is about _teardown_, not _sharing_.
