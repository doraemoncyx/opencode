# Core CodeMode Host

Host side of `@opencode/codemode`: the `execute` tool, the catalog, and the model-facing instructions. The sandbox never learns the host's native tool names, so every remedy that names one lives here.

- The same mistake surfaces as two different diagnostics: `UnknownTool` for `tools.webfetch(...)` and `ExecutionFailure` carrying `Unknown identifier 'webfetch'` for a bare call. `failureHints` in `tool.ts` must rescue both; a fix in one path alone leaves the common case unhelped.
- The advertised sandbox surface in `instructions.ts` is rendered from `CodeMode.globalNames` plus the installed extension globals. Adding an extension global without adding it there leaves the model to discover it by failing.
