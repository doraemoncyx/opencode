import { expect, story } from "../../storybook/playwright/story"

const REASONING_TEXT = "I will inspect the timeline before changing its state."

for (const mode of ["hidden", "compact", "snippet", "full"] as const) {
  for (const reasoning of ["none", "blank", "heading"] as const) {
    story(`projects ${mode} mode with ${reasoning} active reasoning`, async ({ mount }) => {
      const timeline = await mount("current-session-timeline-rows--conversation", {
        args: { scenario: "reasoning", mode, reasoning },
      })
      await expect(timeline.locator('[data-timeline-row="UserMessage"]')).toContainText(
        "Find why the Session header shifts after the first streamed response.",
      )
      const active = mode !== "hidden" && reasoning !== "none"
      const part = timeline.locator('[data-timeline-part-id="msg_projection_assistant:reasoning:0"]')
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(active ? 1 : 0)
      await expect(part).toHaveCount(active ? 1 : 0)
      if (!active || reasoning !== "heading") {
        await expect(timeline.getByText("Inspecting stability", { exact: true })).toHaveCount(0)
        return
      }
      const trigger = part.getByRole("button")
      const body = part.locator('[data-component="markdown"]').getByText(REASONING_TEXT, { exact: true })
      const preview = part.locator('[data-slot="reasoning-preview"]')
      await expect(trigger).toHaveAttribute("aria-expanded", String(mode === "full"))
      await expect(part.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
      await expect(preview).toHaveCount(mode === "snippet" ? 1 : 0)
      if (mode === "full") {
        await expect(body).toBeVisible()
        await expect(trigger).not.toContainText("Inspecting stability")
      } else {
        // A collapsed thought names itself; preview mode also shows its opening lines.
        await expect(trigger).toContainText("Inspecting stability")
        await expect(body).toBeHidden()
        await trigger.click()
      }
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(preview).toHaveCount(0)
      await expect(body).toBeVisible()
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(body).toBeHidden()
      await expect(trigger).toContainText("Inspecting stability")
    })
  }

  for (const following of ["tool", "text"] as const) {
    story(`stops Thinking before ${following} in ${mode} mode`, async ({ mount }) => {
      const timeline = await mount("current-session-timeline-rows--conversation", {
        args: {
          scenario: "reasoning",
          mode,
          reasoning: "heading",
          tool: following === "tool",
          text: following === "text" ? "The timeline is stable" : "",
        },
      })
      const part = timeline.locator('[data-timeline-part-id="msg_projection_assistant:reasoning:0"]')
      if (following === "tool") {
        const group = timeline.locator('[data-component="collapsed-tool-group"]')
        const trigger = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
        await expect(trigger).toHaveText(/^Used\s*1\s*Skill$/)
        await expect(trigger).toHaveAttribute("aria-expanded", "false")
        await expect(
          group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
        ).toHaveText("Skill")
        await expect(timeline.getByText("Inspecting stability", { exact: true })).toBeHidden()
        await trigger.click()
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
        await expect(group.locator('[data-timeline-part-id="tool_reasoning_projection_skill"]')).toBeVisible()
        await expect(group.locator('[data-component="reasoning-part"]')).toHaveCount(mode === "hidden" ? 0 : 1)
      }
      if (following === "text")
        await expect(timeline.getByText("The timeline is stable", { exact: true })).toBeVisible()
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
      await expect(part).toHaveCount(mode === "hidden" ? 0 : 1)
      if (mode === "hidden") return
      const thought = part.locator('[data-slot="collapsible-trigger"]')
      const thoughtTitle = thought.locator('[data-slot="basic-tool-tool-title"]')
      const subtitles = thought.locator('[data-slot="basic-tool-tool-subtitle"]')
      const body = part.locator('[data-component="markdown"]').getByText(REASONING_TEXT, { exact: true })
      await expect(thoughtTitle).toContainText("Thought")
      await expect(thoughtTitle).toHaveCSS("font-size", "13px")
      await expect(thoughtTitle).toHaveCSS("line-height", "16px")
      await expect(thought).toHaveAttribute("aria-expanded", String(mode === "full"))
      await expect(part.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "false")
      // A finished thought keeps its label while collapsed; only the expanded row drops it.
      if (mode === "full") await expect(subtitles).toHaveText(["7s"])
      else await expect(subtitles).toHaveText(["Inspecting stability", "7s"])
      if (mode === "snippet") {
        await expect(part.locator('[data-slot="reasoning-preview-line"]')).toHaveText([REASONING_TEXT])
        await expect(body).toBeHidden()
      }
      if (mode !== "full") await thought.click()
      await expect(body).toBeVisible()
    })
  }
}

// Moved from packages/app/e2e/regression/session-timeline-reasoning-projection.spec.ts
story("does not infer reasoning visibility from provider identity", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", {
    args: { scenario: "reasoning", reasoning: "none", text: "No reasoning payload" },
  })
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(timeline.locator('[data-timeline-part-id*="reasoning"]')).toHaveCount(0)
  await expect(timeline.getByText("No reasoning payload", { exact: true })).toBeVisible()
})
