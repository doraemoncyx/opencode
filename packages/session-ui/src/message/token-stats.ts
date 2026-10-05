import type { SessionMessageAssistant, SessionMessageAssistantReasoning } from "@opencode/client/promise"

export function estimateTokens(text: string) {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export type TokenStats = { ttft?: number; tps?: number }

export function computeTokenStats(
  message: Pick<SessionMessageAssistant, "time" | "content" | "tokens">,
  now: number,
): TokenStats {
  const created = message.time.created
  const completed = message.time.completed
  const streamed = message.time.streamed
  const done = typeof completed === "number" && completed > created
  const firstOutput = message.content.find(
    (item): item is SessionMessageAssistantReasoning =>
      item.type === "reasoning" && typeof item.time?.created === "number",
  )?.time?.created
  const start = typeof firstOutput === "number" && firstOutput >= created ? firstOutput : created
  const ttft =
    typeof firstOutput === "number" && firstOutput > created ? Math.round((firstOutput - created) / 1000) : undefined
  const end =
    typeof streamed === "number" && streamed >= start
      ? streamed
      : done && typeof completed === "number"
        ? completed
        : now
  const genMs = Math.max(0, end - start)
  const gen = done
    ? (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    : message.content.reduce((total, item) => {
        if (item.type !== "text" && item.type !== "reasoning") return total
        return total + estimateTokens(item.text)
      }, 0)
  const tps = gen > 0 && genMs > 0 ? gen / (genMs / 1000) : undefined
  return { ttft: ttft && ttft > 0 ? ttft : undefined, tps }
}
