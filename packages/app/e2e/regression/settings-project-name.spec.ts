import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/Projects/settings-demo"
const project = {
  id: "proj_settings_demo",
  canonical: directory,
  name: "Settings demo",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
}

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" })

async function setup(page: Page, holdProjectList: boolean) {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  const gate = Promise.withResolvers<void>()
  if (holdProjectList) {
    // Registered after the mock so the request is intercepted first and falls back to it.
    await page.route("**/api/project", async (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      await gate.promise
      await route.fallback()
    })
  }
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  return gate
}

async function openProject(page: Page, label: string) {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: label, exact: true }).click()
  return settings
}

test("adopts project metadata that arrives after the project settings open", async ({ page }) => {
  const gate = await setup(page, true)
  const settings = await openProject(page, "settings-demo")
  const name = settings.getByRole("textbox", { name: "Project name", exact: true })
  // Only the folder name is known while the project list is still in flight.
  await expect(name).toHaveValue("settings-demo")

  gate.resolve()

  await expect(name).toHaveValue("Settings demo")
})

test("renames a project added in this session without reloading", async ({ page }) => {
  const added = "C:/Projects/added-project"
  const addedProject = {
    id: "proj_added",
    canonical: added,
    name: "Added project",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
  const exists = { value: false }
  await mockOpenCodeServer(page, {
    directory: added,
    project: addedProject,
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    // Resolving the location is what creates the project on the server, so the listing
    // that runs first is what makes the project exist.
    fileList: (path) => {
      exists.value = true
      return path === "C:/Projects" ? [{ path: "./", type: "directory", ignored: false }] : []
    },
  })
  await page.route("**/api/project", async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    if (!exists.value) return route.fulfill({ json: [] })
    await route.fallback()
  })
  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] } }))
  })
  await page.goto("/")

  await page.locator('[data-action="home-add-project-row"]').click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  await picker.getByRole("button", { name: "Parent", exact: true }).click()
  await picker.getByRole("treeitem", { name: "added-project", exact: true }).click()
  await picker.getByRole("button", { name: "Select folder", exact: true }).click()
  await expect(picker).toBeHidden()

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: addedProject.name, exact: true }).click()
  const name = settings.getByRole("textbox", { name: "Project name", exact: true })
  await expect(name).toHaveValue(addedProject.name)

  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname === `/api/project/${addedProject.id}`,
  )
  await name.fill("Renamed after add")
  await name.blur()

  expect((await saved).postDataJSON()).toEqual({ name: "Renamed after add" })
})

test("commits a project name when Enter is pressed", async ({ page }) => {
  await setup(page, false)
  const settings = await openProject(page, "Settings demo")
  const name = settings.getByRole("textbox", { name: "Project name", exact: true })
  await expect(name).toHaveValue("Settings demo")

  const saved = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/project/${project.id}`,
  )
  await name.fill("Renamed with Enter")
  await name.press("Enter")

  expect((await saved).postDataJSON()).toEqual({ name: "Renamed with Enter" })
  await expect(settings.getByRole("tab", { name: "Renamed with Enter", exact: true })).toBeVisible()
})

test("saves a project name edited when leaving the settings view", async ({ page }) => {
  await setup(page, false)
  const settings = await openProject(page, "Settings demo")
  const name = settings.getByRole("textbox", { name: "Project name", exact: true })
  await expect(name).toHaveValue("Settings demo")

  const saved = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/project/${project.id}`,
  )
  await name.fill("Renamed on leave")
  await page.keyboard.press("Escape")

  expect((await saved).postDataJSON()).toEqual({ name: "Renamed on leave" })
  await expect(settings.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
})
