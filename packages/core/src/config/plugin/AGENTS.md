## Command sources

- Custom `/` commands load from each config entry's `{command,commands}/**/*.md` (both singular and plural are valid) and the `command` config key; nested directories produce nested command names, and the `.md` filename is the command name.
- `command.ts` expands `$N`, `$ARGUMENTS`, and `` !`shell` `` at execution time; `subtask` is a deprecated alias for `subagent`.
- The `loadDirectory` scan glob, the `isCommandSource` watch check, and the name-strip regex in `decode` must stay in sync when the directory pattern changes.
