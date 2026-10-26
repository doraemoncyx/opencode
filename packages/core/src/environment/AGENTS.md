# Core Environment

## Drive roots reject recursive mkdir

On Windows, `fs.mkdir("G:\\", { recursive: true })` fails with `EPERM` even though the root exists, so every parent-creating path must skip a filesystem root (`value === path.parse(value).root`). Without that guard, `Files.write` fails for any target directly under a drive (`G:\file.md`) and the write tool reports it only as `Unable to write G:\file.md`, which reads as a permissions problem. `environment/memory.ts` already guards its own `mkdirSync` the same way.
