import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Hash } from "@opencode/util/hash"
import type { DatabaseMigration } from "../migration.js"

type Row = {
  id: string
  worktree: string
  name: string | null
  icon_url: string | null
  icon_url_override: string | null
  icon_color: string | null
  commands: string | null
  time_updated: number
}

// Tables holding a project reference. Legacy `session` and `workspace` shapes are still
// present on some installs, so every table is inspected before it is touched.
const CHILD_TABLES = ["permission", "project_directory", "session", "session_v2", "workspace", "worktree"]

const migration: DatabaseMigration.Migration = {
  id: "20260915120000_project_directory_identity",
  foreignKeys: false,
  up(tx) {
    return Effect.gen(function* () {
      const rows = yield* tx.all<Row>(sql`
        SELECT id, worktree, name, icon_url, icon_url_override, icon_color, commands, time_updated
        FROM project
        WHERE vcs IS NULL
        ORDER BY id
      `)

      // Markerless projects are identified by their directory, so directories that only
      // differ in case produced one project row each. Group them and merge into the row
      // whose id the current identity rule produces.
      const groups = new Map<string, Row[]>()
      for (const row of rows) {
        const key = normalize(row.worktree)
        const group = groups.get(key)
        if (group) group.push(row)
        else groups.set(key, [row])
      }

      for (const [directory, group] of groups) {
        if (group.length < 2) continue
        // The global project is never merged away.
        if (group.some((row) => row.id === Project.ID.global)) continue
        const canonical = Hash.fast(`directory:${directory}`)
        const target = group.find((row) => row.id === canonical)
        // Keep groups whose canonical row is gone rather than guessing a winner.
        if (!target) continue

        const name = newest(group, (row) => row.name)
        const icon = newest(group, (row) => row.icon_url ?? row.icon_url_override ?? row.icon_color)
        const commands = newest(group, (row) => row.commands)
        // Metadata columns are written as a set, so the whole icon comes from the row
        // that last changed it instead of mixing an old image with a new color.
        yield* tx.run(sql`
          UPDATE project SET
            worktree = ${directory},
            name = ${(name ?? target).name},
            icon_url = ${(icon ?? target).icon_url},
            icon_url_override = ${(icon ?? target).icon_url_override},
            icon_color = ${(icon ?? target).icon_color},
            commands = ${(commands ?? target).commands},
            time_updated = ${Math.max(...group.map((row) => row.time_updated))}
          WHERE id = ${canonical}
        `)

        for (const duplicate of group) {
          if (duplicate.id === canonical) continue
          yield* repoint(tx, canonical, duplicate.id)
          yield* tx.run(sql`DELETE FROM project WHERE id = ${duplicate.id}`)
        }
      }
    })
  },
}

export default migration

// Frozen copy of the identity rule in `project/identity.ts`: migrations must keep the
// behavior they were written against when that rule changes.
const windowsDrive = /^[a-z]:[\\/]/i

function normalize(directory: string) {
  if (!windowsDrive.test(directory) && !directory.startsWith("\\\\") && !directory.startsWith("//")) return directory
  return directory.replaceAll("\\", "/").toLowerCase()
}

function newest(rows: Row[], value: (row: Row) => string | null) {
  return rows
    .filter((row) => value(row) !== null)
    .reduce<Row | undefined>((best, row) => (!best || row.time_updated > best.time_updated ? row : best), undefined)
}

function repoint(tx: Parameters<DatabaseMigration.Migration["up"]>[0], canonical: string, duplicate: string) {
  return Effect.gen(function* () {
    for (const table of CHILD_TABLES) {
      const columns = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`)
      if (!columns.some((column) => column.name === "project_id")) continue
      // `OR IGNORE` skips rows that collide with one the keeper already owns, and the
      // delete below removes exactly those collisions.
      yield* tx.run(
        sql`UPDATE OR IGNORE ${sql.identifier(table)} SET project_id = ${canonical} WHERE project_id = ${duplicate}`,
      )
      yield* tx.run(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${duplicate}`)
    }
  })
}
