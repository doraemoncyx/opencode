import type {
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { reasoningSummary } from "../../context/thinking"
import { Locale } from "../../util/locale"

export type Activity = {
  readonly label: string
  readonly since?: number
  readonly queued: number
}

export type ActivityStats = {
  readonly ttft?: number
  readonly tps?: number
}

export function estimateTokens(text: string) {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export function deriveActivity(
  messages: readonly SessionMessageInfo[],
  options: { readonly running: boolean; readonly queued?: number },
): Activity | undefined {
  if (!options.running) return
  const queued = options.queued ?? 0
  const pendingIndex = messages.findLastIndex(
    (message) => message.type === "assistant" && message.time.completed === undefined,
  )
  if (pendingIndex === -1) return { label: "Working", queued }
  const pending = messages[pendingIndex]
  if (pending.type !== "assistant") return { label: "Working", queued }

  for (let index = pending.content.length - 1; index >= 0; index--) {
    const part = pending.content[index]
    if (part.type !== "tool") continue
    if (part.state.status === "streaming")
      return { label: `Queued ${part.name}`, since: pending.time.created, queued }
    if (part.state.status === "running")
      return { label: runningToolLabel(part), since: part.time.ran ?? part.time.created, queued }
  }

  const last = pending.content.at(-1)
  if (last?.type === "reasoning" && last.time?.completed === undefined) {
    const summary = reasoningSummary(last.text.replace("[REDACTED]", "").trim())
    return {
      label: summary.title ? `Thinking: ${summary.title}` : "Thinking",
      since: last.time?.created,
      queued,
    }
  }
  // V2 text parts carry no timing, so a writing turn's elapsed clock starts at the message.
  if (last?.type === "text" && last.text.trim()) return { label: "Writing", since: pending.time.created, queued }
  return { label: "Waiting for model", since: pending.time.created, queued }
}

export function runningToolLabel(part: SessionMessageAssistantTool) {
  if (part.state.status !== "running") return `Running ${part.name}`
  const title = typeof part.state.metadata.title === "string" ? part.state.metadata.title : undefined
  const command = typeof part.state.input.command === "string" ? part.state.input.command : undefined
  const detail = title ?? (command?.trim() ? command.trim().split("\n")[0] : undefined)
  return detail ? `Running ${part.name}: ${detail}` : `Running ${part.name}`
}

export function computeStats(messages: readonly SessionMessageInfo[], now: number): ActivityStats | undefined {
  let totalTokens = 0
  let totalMs = 0
  const ttfts: number[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const { created, streamed, completed } = message.time
    const done = typeof completed === "number" && completed > created
    // V2 keeps the first output timestamp on the first reasoning part; text parts are
    // untimed, so a message that streamed only text still contributes tps without ttft.
    const firstOutput = message.content.find(
      (item): item is SessionMessageAssistantReasoning =>
        item.type === "reasoning" && typeof item.time?.created === "number",
    )?.time?.created
    const start = typeof firstOutput === "number" && firstOutput >= created ? firstOutput : created
    const end =
      typeof streamed === "number" && streamed >= start
        ? streamed
        : done && typeof completed === "number"
          ? completed
          : now
    const genMs = Math.max(0, end - start)
    const gen = done
      ? (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
      : message.content.reduce(
          (total, item) =>
            item.type === "text" || item.type === "reasoning" ? total + estimateTokens(item.text) : total,
          0,
        )
    if (gen <= 0 || genMs <= 0) continue
    totalTokens += gen
    totalMs += genMs
    if (typeof firstOutput === "number" && firstOutput > created) ttfts.push(firstOutput - created)
  }
  if (totalTokens <= 0 || totalMs <= 0) return
  return {
    ttft: ttfts.length ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : undefined,
    tps: totalTokens / (totalMs / 1000),
  }
}

export function formatActivity(activity: Activity, now: number) {
  const parts = [activity.label]
  if (activity.since !== undefined) parts.push(Locale.duration(Math.max(0, now - activity.since)))
  if (activity.queued > 0) parts.push(`${activity.queued} queued`)
  return parts.join(" \u00b7 ")
}

export function formatStats(stats: ActivityStats) {
  const parts: string[] = []
  if (stats.ttft !== undefined) parts.push(`avg ttft ${Locale.duration(stats.ttft)}`)
  if (stats.tps !== undefined && stats.tps > 0) parts.push(`avg ${stats.tps.toFixed(1)} tps`)
  return parts.join(" \u00b7 ")
}
