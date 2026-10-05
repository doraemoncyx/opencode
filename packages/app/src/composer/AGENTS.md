## Input triggers

- The `!` shell, `@` mention, and `/` command triggers are decided in `suggestions/machine.ts` (`inputChanged`), not in `editor.tsx`. Mode changes reach the view through `editor/interaction.ts` `dispatch`, which calls `view.shell.onOpen`/`onClose`.
- Trigger matching is exact: shell mode requires the whole input to equal `!`; slash commands require the whole input to match `/^\/(\S*)$/`; `@` requires a line-start or whitespace boundary with no whitespace after it. The `!` check clears the draft and is not a prefix trigger.
- The TUI mirrors these triggers separately (`packages/tui/src/prompt/display.ts`, `component/prompt/index.tsx`); a trigger-behavior change must land in both clients.
