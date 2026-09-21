import { getFilename } from "@opencode/util/path"
import type { ProjectUpdateInput } from "@opencode/client/promise"
import { batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import type { LocalProject } from "@/shell/state/layout"
import { ServerConnection } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"

type ProjectPatch = Pick<ProjectUpdateInput, "name" | "icon" | "commands">

export function createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const global = useGlobal()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  // The project record arrives after this view mounts, so its values stay reactive and
  // the store adopts them instead of capturing whatever was known at creation.
  const projectName = createMemo(() => props.project.name ?? "")
  const projectStartup = createMemo(() => props.project.commands?.start ?? "")
  const projectColor = createMemo(() => props.project.icon?.color)
  const projectOverride = createMemo(() => props.project.icon?.override)
  const [store, setStore] = createStore({
    name: defaultName(),
    color: projectColor(),
    iconOverride: projectOverride(),
    startup: projectStartup(),
    dirty: { name: false, startup: false, color: false, iconOverride: false },
    dragOver: false,
    iconHover: false,
    saving: 0,
  })
  const saved = {
    name: projectName(),
    startup: projectStartup().trim(),
    color: projectColor(),
    iconOverride: projectOverride(),
  }
  // Last record value this model accounted for, so a value the user just saved is never
  // replaced by an older echo of the same field.
  const seen = {
    name: projectName(),
    startup: projectStartup(),
    color: projectColor(),
    iconOverride: projectOverride(),
  }
  let iconInput: HTMLInputElement | undefined
  let queue = Promise.resolve()

  // Adopt record values that arrive or change after mount for fields without an
  // unwritten edit.
  createEffect(() => {
    const record = {
      name: projectName(),
      startup: projectStartup(),
      color: projectColor(),
      iconOverride: projectOverride(),
    }
    if (store.saving) return
    if (!store.dirty.name && seen.name !== record.name) {
      seen.name = record.name
      saved.name = record.name
      setStore("name", record.name || folderName())
    }
    if (!store.dirty.startup && seen.startup !== record.startup) {
      seen.startup = record.startup
      saved.startup = record.startup
      setStore("startup", record.startup)
    }
    if (!store.dirty.color && seen.color !== record.color) {
      seen.color = record.color
      saved.color = record.color
      setStore("color", record.color)
    }
    if (!store.dirty.iconOverride && seen.iconOverride !== record.iconOverride) {
      seen.iconOverride = record.iconOverride
      saved.iconOverride = record.iconOverride
      setStore("iconOverride", record.iconOverride)
    }
  })

  const persist = (patch: ProjectPatch, complete: () => void) => {
    setStore("saving", (value) => value + 1)
    queue = queue
      .then(async () => {
        if (props.project.id && props.project.id !== "global") {
          const project = await serverCtx().sdk.api.project.update({ projectID: props.project.id, ...patch })
          serverCtx().sync.project.update(project)
          return
        }
        serverCtx().sync.project.meta(props.project.worktree, patch)
      })
      .then(complete)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : language.t("common.requestFailed"),
        })
      })
      .finally(() => setStore("saving", (value) => value - 1))
  }

  // An empty name means "use the folder name", so clearing the field stores no name.
  const nameValue = (input: string) => {
    const value = input.trim()
    return value === folderName() ? "" : value
  }

  const saveName = () => {
    const value = nameValue(store.name)
    // A pending write can change the saved value, so reverting to it must still be queued.
    if (!store.saving && value === saved.name) {
      setStore("dirty", "name", false)
      return
    }
    persist({ name: value }, () => {
      saved.name = value
      if (nameValue(store.name) === value) setStore("dirty", "name", false)
    })
  }

  const saveStartup = () => {
    const value = store.startup.trim()
    if (!store.saving && value === saved.startup) {
      setStore("dirty", "startup", false)
      return
    }
    persist({ commands: { start: value } }, () => {
      saved.startup = value
      if (store.startup.trim() === value) setStore("dirty", "startup", false)
    })
  }

  const saveIcon = (color = store.color, override = store.iconOverride) => {
    if (!store.saving && color === saved.color && override === saved.iconOverride) {
      setStore("dirty", "color", false)
      setStore("dirty", "iconOverride", false)
      return
    }
    persist({ icon: { color: color ?? "", override: override ?? "" } }, () => {
      saved.color = color
      saved.iconOverride = override
      if (store.color === color) setStore("dirty", "color", false)
      if (store.iconOverride === override) setStore("dirty", "iconOverride", false)
    })
  }

  function selectFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result !== "string") return
      batch(() => {
        setStore("iconOverride", result)
        setStore("dirty", "iconOverride", true)
        setStore("iconHover", false)
      })
      saveIcon(store.color, result)
    }
    reader.readAsDataURL(file)
  }

  return {
    store,
    setStore,
    folderName,
    defaultName,
    saveName,
    saveStartup,
    // Text fields write on blur, so they track local edits until they are persisted.
    setName(value: string) {
      batch(() => {
        setStore("dirty", "name", true)
        setStore("name", value)
      })
    },
    setStartup(value: string) {
      batch(() => {
        setStore("dirty", "startup", true)
        setStore("startup", value)
      })
    },
    setColor(value: string | undefined) {
      batch(() => {
        setStore("color", value)
        setStore("dirty", "color", value !== saved.color)
      })
      saveIcon(value, store.iconOverride)
    },
    drop(event: DragEvent) {
      event.preventDefault()
      setStore("dragOver", false)
      const file = event.dataTransfer?.files[0]
      if (file) selectFile(file)
    },
    dragOver(event: DragEvent) {
      event.preventDefault()
      setStore("dragOver", true)
    },
    dragLeave() {
      setStore("dragOver", false)
    },
    inputChange(input: HTMLInputElement) {
      const file = input.files?.[0]
      if (file) selectFile(file)
    },
    iconClick() {
      if (store.iconOverride && store.iconHover) {
        batch(() => {
          setStore("iconOverride", "")
          setStore("dirty", "iconOverride", true)
        })
        saveIcon(store.color, "")
        return
      }
      iconInput?.click()
    },
    setIconInput(input: HTMLInputElement) {
      iconInput = input
    },
  }
}
