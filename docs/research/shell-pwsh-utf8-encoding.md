# Forcing UTF-8 output for the PowerShell `shell` tool (v2)

Research note. Read-only investigation; no source files were changed. Companion to
[`mcp-process-accumulation.md`](./mcp-process-accumulation.md).

**Question.** Can the opencode `shell` tool force the console/output encoding to
UTF-8 before invoking a command when the selected shell is PowerShell
(`pwsh` or `powershell`)? What is the exact mechanism, where would it hook in,
and what are the caveats?

## Short answer

**Yes, and the mechanism is a one-line `-Command` preamble**
`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`
(optionally wrapped in `try { … } catch {}`), applied only to the PowerShell
branch of `ShellSelect.args`. It reliably flips **PowerShell's own stdout and
stderr** to UTF-8 for both Windows PowerShell 5.1 and PowerShell 7, including
under opencode's actual spawn flags (`windowsHide: true`, piped stdio). On a
zh-CN host the opencode spawn currently produces **GBK** bytes from `pwsh` as
well as `powershell.exe`, so the common claim that "PowerShell 7 is already
UTF-8" does not cover this case (see §3).

**But it is not a complete fix and it is not free.** It does **not** change the
encoding of native child programs (`python`, `git`, `svn`, …) redirected to the
same pipe — for those only per-tool env vars (`PYTHONIOENCODING`, `PYTHONUTF8`)
or per-tool flags work. It also calls `SetConsoleOutputCP(65001)` as a side
effect, changes bytes for commands that assume the locale code page, and adds
one trusted statement to every invocation (which the permission scanner never
sees, because it runs first). The repo already decodes GBK/UTF-8 **per line**,
so the preamble is a locale-independence improvement, not the only defence
against mojibake.

**Recommended minimal change:** add the prefix inside `ShellSelect.args`'s
PowerShell branch (`packages/core/src/shell/select.ts:192`) so both call sites
(`packages/core/src/shell.ts:297` and `packages/core/src/config/plugin/command.ts:223`)
inherit it without touching permission analysis. See §8.

---

## 1. What actually controls the bytes

PowerShell has several encoding knobs and they do different jobs. Getting them
confused is the source of most conflicting advice.

| Knob | Scope | Default (WinPS 5.1) | Default (PS 7) | Controls |
| --- | --- | --- | --- | --- |
| `[Console]::OutputEncoding` | process | console output code page (ANSI/OEM) | console output code page (ANSI/OEM) | how the .NET console writer encodes bytes written to **stdout/stderr**, including host output |
| `$OutputEncoding` | session | `us-ascii` | `utf-8` | encoding PowerShell uses to write strings **into a native process's stdin** |
| `-Encoding` / `$PSDefaultParameterValues` | per cmdlet | locale (UTF-16LE for `Out-File`, `>`/`>>`) | `utf8NoBOM` | cmdlets that write **files** (`Out-File`, `Set-Content`, `Export-Csv`, …) |
| `chcp N` / `SetConsoleOutputCP(N)` | console | OEM code page | OEM code page | the console's code page; a native program only uses it when its stdout **is the console** |

Primary sources:

- `$OutputEncoding` — "Determines the character encoding method that PowerShell
  uses when **piping data into native applications**", default `UTF8Encoding`
  ([about_Preference_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.6),
  `$OutputEncoding` section). One sentence earlier, `about_Character_Encoding`
  says the same: "The automatic variable `$OutputEncoding` affects the encoding
  PowerShell uses to communicate with external programs. It has no effect on the
  encoding that the output redirection operators and PowerShell cmdlets use."
  ([about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7.6)).
  So setting `$OutputEncoding` does **not** fix PowerShell's own stdout.
- `[Console]::OutputEncoding` — on Windows the getter reads
  `GetConsoleOutputCP()` and the setter calls `SetConsoleOutputCP()`. .NET runtime
  source: `ConsolePal.SetConsoleOutputEncoding` calls
  `Interop.Kernel32.SetConsoleOutputCP(enc.CodePage)`, and
  `HandleSetConsoleEncodingError` fails **silently** on `ERROR_INVALID_HANDLE`
  or `ERROR_INVALID_ACCESS` ("no console, or not a valid handle")
  (`dotnet/runtime` `src/libraries/System.Console/src/System/ConsolePal.Windows.cs`,
  `SetConsoleOutputEncoding` / `HandleSetConsoleEncodingError`). The cached
  encoding is replaced and `Console.Out`/`Console.Error` are rebuilt with it
  (`Console.cs`, `OutputEncoding` setter → `Volatile.Write(ref s_outputEncoding, …)`;
  `CreateOutputWriter` uses `OutputEncoding.RemovePreamble()`).
- `Console.cs` propagates the encoding even when stdout is redirected: the
  writer is only *not* torn down when someone called `Console.SetOut(...)` (the
  `s_isOutTextWriterRedirected` flag), which PowerShell does not do for normal
  host output. `ConsolePal.OpenStandardOutput` also switches to file APIs when
  `Console.IsOutputRedirected`, i.e. writes the encoded bytes straight to the
  pipe. This is why the preamble works with piped stdout.
- `/docs` also documents that the getter may return a cached value if the code
  page was changed by other means, and that UTF-32 is unsupported
  ([Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding?view=net-10.0)).

**Two distinct output classes must be separated:**

1. **PowerShell's own output** (cmdlet results, formatted tables, error records,
   `Write-Host`). This goes through the host/`Console.Out` and *is* controlled by
   `[Console]::OutputEncoding`.
2. **Native program output** (`python`, `git`, `svn`, `cargo`, …). When the
   native program's stdout is the pipe handed to PowerShell, its bytes are
   produced by *that program* and are unaffected by PowerShell's console
   encoding. See §5.

---

## 2–3. Version behaviour: documented vs observed

**Documented.** `about_Character_Encoding` states: "In Windows PowerShell, any
Unicode encoding, except `UTF7`, always creates a BOM. PowerShell (v6 and
higher) defaults to `utf8NoBOM` for all text output", and "PowerShell defaults to
`utf8NoBOM` for all output." Windows PowerShell 5.1's documented default is
UTF-16LE for `Out-File`/`>`/`>>`, and "the default encoding used by cmdlets in
Windows PowerShell is not consistent."

That statement is about **cmdlet/file output and the `-Encoding` default**. It
does not mean the console host writes UTF-8 to a redirected stdout. The console
host writes through `[Console]::OutputEncoding`, which on Windows is the console
output code page — and when there is no console (opencode's `windowsHide: true`
spawn, `packages/util/src/cross-spawn-spawner.ts:426`), the code page lookup
falls back to the system ANSI code page (CP936 on this zh-CN host).

**Observed locally** (Windows 11, zh-CN, PowerShell 7.6.6, Windows PowerShell
5.1.26100.9444; probe script `C:\cache\tmp\bin\psenc_probe.py` and
`C:\cache\tmp\spawn_probe2.mjs`; the spawn uses the repo's own flags —
`windowsHide: true`, `detached: false`, piped stdio):

| Case (spawn = repo flags) | stdout of `Write-Output '中文'` | `[Console]::OutputEncoding.WebName` |
| --- | --- | --- |
| `pwsh` plain | **GBK** (`d6 d0 ce c4`) | `gb2312` |
| `pwsh` `[Console]::OutputEncoding=UTF8; …` | UTF-8 (`e4 b8 ad …`) | — |
| `powershell` plain | **GBK** | `gb2312` |
| `powershell` `[Console]::OutputEncoding=UTF8; …` | UTF-8 | — |
| `pwsh` error record on stderr | **GBK** | — |
| `pwsh` error record, prefix applied | **UTF-8** | — |

So under opencode's spawn **both** shells emit the locale code page by default,
and the preamble fixes **stdout and stderr** alike. The earlier "PowerShell 7 is
UTF-8" assumption holds only when a console with code page 65001 is attached; the
repo does not attach one (`windowsHide: true`).

Corroborating upstream reports: the same version-dependent split is documented in
[PowerShell #17523](https://github.com/PowerShell/PowerShell/issues/17523)
(pipe parsing differs 5.1 vs 6/7) and
[PowerShell #25698](https://github.com/PowerShell/PowerShell/issues/25698)
(PS 7.5.2 still depends on `[Console]::OutputEncoding` in pipelines). There is an
open PowerShell request to make the host switch the console code page to UTF-8
before profiles run ([PowerShell #14945](https://github.com/PowerShell/PowerShell/issues/14945)):
"Make PowerShell (ConsoleHost) by default switch the console input and output
code page to UTF-8".

The repo already contains evidence that this output is *not* reliably one
encoding: the desktop WSL side runs `powershell.exe` and decodes its output by
sniffing a UTF-16LE BOM/NUL pattern
(`packages/desktop/src/main/wsl/runtime.ts:184-204`, `createOutputDecoder` /
`detectOutputEncoding`), i.e. it has seen `powershell.exe` emit UTF-16LE.

---

## 4. Does a `-Command` preamble work reliably?

The candidate payloads, ordered by what they actually fix:

```powershell
# PowerShell's own stdout + stderr (necessary and sufficient for that class)
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;

# Also make PowerShell encode strings it pipes INTO native apps as UTF-8.
# On WinPS 5.1 $OutputEncoding defaults to us-ascii, so piping non-ASCII into
# a native program mangles it to '?'. Irrelevant to native OUTPUT encoding.
$OutputEncoding=[System.Text.Encoding]::UTF8;
```

- **`[Console]::OutputEncoding` is the one that matters for captured output.**
  Verified locally: it alone turns both shells' stdout/stderr UTF-8 under the
  repo's spawn flags.
- `$OutputEncoding` is orthogonal (PowerShell → native stdin). On this host
  WinPS 5.1 reports `us-ascii` and PS 7 reports `utf-8` for it, matching the
  docs. Include it only if `'…' | native.exe` inputs matter; it does not fix
  native program output.
- **Order matters only relative to a user command that sets its own encoding.**
  The preamble runs first, so a later user assignment wins. No ordering issue
  among the preamble's own statements.
- **stderr** goes through the same `[Console]::OutputEncoding`; verified (error
  records flipped from GBK to UTF-8 with the prefix).
- **`-ErrorAction`/`$ErrorView`** affect whether an error is emitted and how it
  is *formatted*; they are not encoding controls. A `try { … } catch {}` around
  the **setter** is still worth keeping as defence: setting the property can
  throw on odd hosts. Modern .NET swallows the no-console case, but
  `dotnet/runtime#98441` shows a detached-console host throwing
  `IOException: Invalid access` from `SetConsoleOutputEncoding`
  ([dotnet/runtime #98441](https://github.com/dotnet/runtime/issues/98441)).
  Codex ships exactly this guard (§7).
- **`-NoProfile` interaction:** profiles are not the mechanism and `-NoProfile`
  does not need to change. It does mean users cannot fix this themselves via
  their profile through opencode, which is why the wrapper must do it. This is
  the same trap Codex hit ([openai/codex #4498](https://github.com/openai/codex/issues/4498),
  [#23044](https://github.com/openai/codex/issues/23044): "codex hardcoded
  `-NoProfile`, causing UTF-8 settings in the profile to be skipped").
- **`-Command` vs `-EncodedCommand`:** opencode uses `-Command`
  (`select.ts:192`); the preamble is just prepended to the same string. With
  `-EncodedCommand` the whole prefixed script would be UTF-16LE Base64
  ([about_Pwsh, `-EncodedCommand`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.6)),
  which avoids argv quoting but doubles length against the ~32k command-line
  limit and would replace opencode's current quoting strategy; nothing here
  requires that switch.

Edge cases for a **blind** prepend (all inference, not measured): a command whose
first token must be the first statement — `param(…)`, `using namespace …`,
`#requires`, a bare here-string opener — would break if a statement is prepended.
In practice the model emits ordinary statements, but this is the main semantic
risk to weigh.

---

## 5. `chcp 65001` and native children

`chcp 65001` (or the equivalent `SetConsoleOutputCP`) is **redundant** for
PowerShell's own output once `[Console]::OutputEncoding` is set, and it does not
fix native children when stdout is a pipe:

- `chcp` without redirection also prints `Active code page: 65001` to stdout,
  polluting captured output, and it mutates the console code page for the whole
  console (a real side effect if a console is shared with the parent).
- A native program writing to a **pipe** does not consult the console code page.
  PEP 528 made Python use the Unicode console APIs *only* when the standard
  stream "is a console buffer rather than a redirected file. Otherwise,
  `_io.FileIO` will be used"
  ([PEP 528](https://peps.python.org/pep-0528/)); for a pipe the encoding is the
  locale/ANSI code page. Python's UTF-8 mode and `PYTHONIOENCODING`/`PYTHONUTF8`
  are the supported levers
  ([Using Python on Windows — UTF-8 mode](https://docs.python.org/3/using/windows.html#utf-8-mode)).

Local proof (probe with `PYTHONIOENCODING`/`PYTHONUTF8` scrubbed): a `python`
child inside `pwsh`/`powershell` reports `sys.stdout.encoding == 'gbk'`
regardless of whether the parent ran plain, with
`[Console]::OutputEncoding = UTF8`, or with `chcp 65001`. The same Python child
reports `utf-8` as soon as `PYTHONIOENCODING=utf-8` is present in the
environment. So:

| Fix | PowerShell's own output | Native child output (pipe) |
| --- | --- | --- |
| `[Console]::OutputEncoding = UTF8` | ✅ UTF-8 | ❌ unchanged |
| `$OutputEncoding = UTF8` | ❌ unchanged | ❌ unchanged (fixes PS → native **stdin**) |
| `chcp 65001` | ⚠️ redundant; pollutes stdout | ❌ unchanged |
| `PYTHONIOENCODING`/`PYTHONUTF8` | ❌ | ✅ for Python only |

There is no single environment variable that sets a child PowerShell's console
output code page; Windows has no `LC_ALL`-style switch for this. A cross-tool
locale-independent result therefore needs both the PowerShell preamble *and*
per-tool env vars (or reliance on the decoder below).

---

## 6. Cost / side effects of a universal preamble

- **Extra trusted statement per invocation.** ~75 characters; negligible
  latency. Its `try/catch` emits nothing.
- **Permission scanning is unaffected if hooked in `ShellSelect.args`.** In
  `packages/core/src/shell.ts` the scan happens first —
  `hooks.trigger("shell", "create.before", …)` (`:293`), then
  `before(invocation)` → `prepare` → `ShellParse.scan` (`:294`, `tool/plugin/shell.ts:124-125`) —
  and `const args = ShellSelect.args(...)` runs only afterwards (`:297`). The
  scanner therefore still sees exactly the model's command. Hooking **before**
  the scan (e.g. mutating `invocation.command` in a `create.before` plugin or in
  `prepare`) would feed `ShellScan.scanPowerShell`
  (`packages/core/src/shell/scan.ts:917`) a synthetic first statement and should
  be avoided.
- **`SetConsoleOutputCP` side effect.** With opencode's `windowsHide: true`
  spawn the child has no console (observed `OutputEncoding=gb2312`), so there is
  no shared console to mutate. Without that flag the call would change the
  code page of a console shared with the parent process — a reason to keep the
  flag.
- **Changes byte output for locale-dependent commands.** Any command that
  deliberately relies on the inherited ANSI code page now sees Unicode. This is
  the intended effect, but a user command that *sets* its own encoding later is
  unaffected (it wins).
- **Does not remove the existing decoder.** The repo decodes output per line as
  UTF-8 or GBK (`packages/util/src/encoding.ts:5-32`, `:68-94`; shell comment at
  `packages/core/src/shell.ts:36-39`), and tests lock mixed GBK+UTF-8 output
  (`packages/core/test/tool-shell.test.ts:205-219`, `:1094-1100`). The preamble
  makes PowerShell's share deterministic UTF-8; native programs can still emit
  GBK, so the per-line decoder is still required.
- **Actually fixes a real locale bug.** `detectEncoding` only knows `utf-8` and
  `gbk` (`packages/util/src/encoding.ts:3`). On an en-US (CP1252) host, an
  accented byte such as `é` (0xE9) is invalid UTF-8 and would be classified
  `gbk` and mis-decoded. Forcing PowerShell output to UTF-8 makes the PowerShell
  half locale-independent; the native half remains locale-dependent.
- **The hardcoded `!`shell`` path would benefit most.**
  `packages/core/src/config/plugin/command.ts:230` decodes interpolation output
  with `.toString("utf8")` and has no GBK fallback, so a PowerShell `!` command
  emitting GBK is mojibake there regardless of the shell tool's decoder. Since
  that path also calls `ShellSelect.args` (`:223`), a prefix there fixes it.
- **Command length / quoting.** The prefix contains no quotes and is passed as
  one argv element under `-Command`; it is safe for `-Command`. See §4 for the
  `param`/`using`/here-string edge cases.

---

## 7. Ecosystem precedent

- **Codex CLI (shipped, Rust).** `codex-rs/shell-command/src/powershell.rs`
  defines `UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"`
  and `prefix_powershell_script_with_utf8()` injects it into the `-Command`
  payload (idempotently), plus a `try_find_pwsh_executable_blocking()` that
  prefers PS 7. Source:
  [openai/codex `powershell.rs`](https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/powershell.rs).
  The accompanying issue explains the read-side gap this does **not** fix —
  `Get-Content`'s ANSI default in 5.1 — and proposes adding
  `$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'` and preferring
  `pwsh` ([openai/codex #23044](https://github.com/openai/codex/issues/23044)).
  See also [openai/codex #4013](https://github.com/openai/codex/issues/4013),
  [#4498](https://github.com/openai/codex/issues/4498),
  [#7290](https://github.com/openai/codex/issues/7290).
- **opencode itself (issue, open).** [anomalyco/opencode #23636](https://github.com/anomalyco/opencode/issues/23636)
  ("PowerShell output encoding for non-ASCII characters on Windows") proposes
  exactly `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; <command>`
  for the v1 `bash`/`cmd()` path and names `-NoProfile` as the reason the user's
  profile can't fix it; a PR (#31658, assigned `Hona`) is linked. This is the
  same change, and is prior art for the v2 hook below.
- **Claude Code.** A user workaround for the same class of bug is a wrapper
  setting **both** variables:
  `powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8; $1"`
  ([anthropics/claude-code #46486](https://github.com/anthropics/claude-code/issues/46486)).
  Claude also hit the inverse problem of forcing stdout encoding on a
  non-redirected wrapper process
  ([anthropics/claude-code #5686](https://github.com/anthropics/claude-code/issues/5686)),
  a reminder that the setter is only appropriate where output is redirected.
- **Other tools** generally tell users to set the system/locale to UTF-8 or
  `chcp 65001` rather than injecting a preamble; those workarounds are outside
  the tool and do not survive a piped spawn, which is why Codex and opencode
  inject at the `-Command` layer instead.

---

## 8. Where it would hook in this repo, and the minimal change

Today the PowerShell argv is built in one place:

```
// packages/core/src/shell/select.ts:189-194
export function args(file: string, command: string) {
  const n = name(file)
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  return ["-c", command]
}
```

`ps(file)` is the PowerShell detector (`select.ts:175-177`, META table
`select.ts:13-23`). Two callers use `args`:

- `packages/core/src/shell.ts:297` — the `shell` tool spawn.
- `packages/core/src/config/plugin/command.ts:223` — `` !`shell` `` interpolation.

Both are downstream of permission scanning, so prefixing here is the
surgically safe spot.

**Minimal change (not made in this note):**

```ts
// select.ts, PowerShell branch only
const UTF8_PREAMBLE =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"
if (ps(file)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${UTF8_PREAMBLE}${command}`]
```

Considerations:

- Gate on `process.platform === "win32"` if the goal is Windows-only; on
  non-Windows PowerShell the setter is harmless but pointless.
- Update the expectation in `packages/core/test/shell.test.ts:82-94`
  (`ShellSelect.args("pwsh", "Write-Output hi")`) and add a test asserting the
  prefix is present once and not duplicated.
- Because the same `args` serves `config/plugin/command.ts`, the interpolation
  path gets UTF-8 for free (and currently needs it: it hardcodes `.toString("utf8")`).
- Keep the per-line decoder untouched; native children still need it.

**Alternatives considered:**

| Option | Verdict |
| --- | --- |
| `ShellSelect.args` prefix (chosen) | Smallest, PowerShell-only, post-scan, covers both callers |
| Mutate `invocation.command` in `prepare`/`create.before` | Feeds the permission scanner the synthetic statement; avoid |
| `chcp 65001` in the preamble | Redundant for PS output, pollutes stdout, no effect on native pipes |
| Prefer `pwsh` only | Already the first entry in `win()` (`select.ts:120-133`), but PS 7 still emits ANSI under `windowsHide` here — insufficient alone |
| `PYTHONIOENCODING`/`PYTHONUTF8` in the spawn env | Complementary; fixes Python children only, not PowerShell or other native tools |
| Do nothing (rely on `decodeShellOutput`) | Works for the zh-CN GBK case (tests pass) but misclassifies CP1252 and any ambiguous line; the hardcoded `!` path has no fallback |

---

## 9. Recommendation

1. **Adopt the `[Console]::OutputEncoding` preamble in `ShellSelect.args` for the
   PowerShell branch on win32**, with `try/catch` and a "do not duplicate"
   guard, and update the `shell.test.ts` argv expectation. It is exactly the
   Codex/opencode-issue precedent, costs almost nothing, and makes PowerShell's
   own stdout/stderr deterministic UTF-8 under opencode's `windowsHide` spawn.
2. **Do not add `chcp 65001`.**
3. **Do not assume the preamble fixes native tools.** If Python output matters,
   add `PYTHONIOENCODING=utf-8`/`PYTHONUTF8=1` to the spawn env; other native
   tools need their own flags.
4. **Keep `decodeShellOutput`'s per-line GBK/UTF-8 detection** for the native
   half and for commands that reset their own encoding.
5. Treat the `param`/`using`/here-string "first token" edge as the open
   correctness question; if it matters, gate the prefix off for those commands
   rather than dropping the prefix.

---

## 10. Local verification (reproduction)

Read-only. Probe scripts live outside the repo at `C:\cache\tmp\bin\psenc_probe.py`
and `C:\cache\tmp\spawn_probe.mjs` / `spawn_probe2.mjs` (Python 3.14, Bun/Node
`child_process`).

```powershell
# How PowerShell encodes its own redirected output, per shell + prefix,
# under the repo's spawn flags (windowsHide:true, detached:false, pipes).
bun C:\cache\tmp\spawn_probe2.mjs

# Broader matrix (CreateProcess vs CREATE_NO_WINDOW; Write-Output vs error
# records; a native python child with -X utf8=0 and PYTHONIOENCODING scrubbed).
psenc_probe.py

# The native-child isolation: [Console]::OutputEncoding and chcp 65001 both
# leave python's redirected stdout at gbk; only PYTHONIOENCODING changes it.
psenc_probe.py --json | Select-String native
```

Observed: `pwsh` and `powershell` plain → GBK; with the prefix → UTF-8 (stdout
and stderr); native `python` → `gbk` in all parent variants, `utf-8` only when
`PYTHONIOENCODING=utf-8` is inherited.

---

## 11. Sources

**Repo (`path:line`)**

- `packages/core/src/shell/select.ts:13-23` (META / `ps`), `:175-177` (`ps`),
  `:189-194` (`args`), `:120-133` (`win()` prefers `pwsh`).
- `packages/core/src/shell.ts:36-39` (GBK byte-safety comment), `:287-297`
  (invocation, `ShellSelect.args`), `:311-341` (spawn + output pump), `:242`
  (`decodeShellOutput`).
- `packages/core/src/tool/plugin/shell.ts:111` (`compatibleShell`), `:124-125`
  (scan), `:199-211` (`shell.create`).
- `packages/core/src/shell/parse.ts:173-205` (legacy scan), `:207-265`
  (portable scan), `:213` (`ShellScan.scanPowerShell`).
- `packages/core/src/shell/scan.ts:917-1251` (`scanPowerShell`).
- `packages/core/src/config/plugin/command.ts:223` (`ShellSelect.args`),
  `:230` (hardcoded `.toString("utf8")`).
- `packages/util/src/encoding.ts:3` (`FileEncoding = "utf-8" | "gbk"`),
  `:5-32` (`detectEncoding`), `:68-94` (`decodeShellOutput`).
- `packages/util/src/cross-spawn-spawner.ts:419-427` (`detached`/`windowsHide`
  spawn options; `windowsHide` at `:426`).
- `packages/desktop/src/main/wsl/runtime.ts:49-55` (`runPowerShell`),
  `:184-204` (`createOutputDecoder`/`detectOutputEncoding`, UTF-16LE sniffing).
- Tests: `packages/core/test/shell.test.ts:82-94` (argv expectation),
  `packages/core/test/tool-shell.test.ts:205-219` (mixed GBK/UTF-8 fixtures),
  `:1094-1100` (raw GBK bytes survive).
- Local probes: `C:\cache\tmp\bin\psenc_probe.py`, `C:\cache\tmp\spawn_probe.mjs`,
  `C:\cache\tmp\spawn_probe2.mjs`.

**Upstream prior art**

- Codex implementation:
  <https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/powershell.rs>
  (`UTF8_OUTPUT_PREFIX`, `prefix_powershell_script_with_utf8`).
- Codex issues: <https://github.com/openai/codex/issues/23044>,
  <https://github.com/openai/codex/issues/4013>,
  <https://github.com/openai/codex/issues/4498>,
  <https://github.com/openai/codex/issues/7290>.
- opencode: <https://github.com/anomalyco/opencode/issues/23636> (PR #31658).
- Claude Code: <https://github.com/anthropics/claude-code/issues/46486>,
  <https://github.com/anthropics/claude-code/issues/5686>.
- PowerShell: <https://github.com/PowerShell/PowerShell/issues/14945>,
  <https://github.com/PowerShell/PowerShell/issues/17523>,
  <https://github.com/PowerShell/PowerShell/issues/25698>,
  <https://github.com/PowerShell/PowerShell/issues/10789>.

**Primary docs / source**

- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7.6>
  (BOM, `utf8NoBOM` default, `$OutputEncoding` scope, `$PSDefaultParameterValues`).
- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.6>
  (`$OutputEncoding`, `$ErrorView`, `$ErrorActionPreference`).
- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.6>
  (`-Command`, `-EncodedCommand`, `-NoProfile`, `-NonInteractive`, `-OutputFormat`).
- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection?view=powershell-7.6>
  (file redirection uses `UTF8NoBOM`; 7.4 native byte-stream change).
- <https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding?view=net-10.0>
- .NET runtime source: `ConsolePal.Windows.cs` (`SetConsoleOutputEncoding`,
  `HandleSetConsoleEncodingError`) and `Console.cs` (setter rebuilds `s_out`,
  `CreateOutputWriter`) — <https://github.com/dotnet/runtime/tree/main/src/libraries/System.Console/src/System>.
- <https://github.com/dotnet/runtime/issues/98441> (setter can throw with a
  detached console).
- <https://peps.python.org/pep-0528/> (Unicode console APIs only for console
  buffers; file/pipe uses locale encoding),
  <https://docs.python.org/3/using/windows.html#utf-8-mode> (`PYTHONIOENCODING`,
  `PYTHONUTF8`).
- <https://nodejs.org/api/child_process.html> (`windowsHide`, `detached`,
  `stdio` pipe semantics).
- `SetConsoleOutputCP` console-code-page scope is evidenced by the .NET call
  site above; the Win32 page itself was not fetched for this note.

**Unverified / open**

- The .NET Framework reference source for `Console.OutputEncoding`'s setter
  (Windows PowerShell 5.1 runtime) could not be fetched from the mirror used
  here (404). On this host the setter did **not** throw in either console mode;
  the Codex `try/catch` is still the safer form.
- Whether the preamble breaks the "first statement must be first" cases
  (`param`, `using`, `#requires`, bare here-string opener) is reasoned from
  PowerShell syntax, not measured.
- The exact console code page seen by a `windowsHide: true` child can vary by
  Windows build; the ANSI/GBK result above is this host (Windows 11, zh-CN).
  A non-CJK host should be re-probed before generalising.
