/** A half-open wall-clock interval `[start, end)` for one rendered block. */
export type BlockTime = { start: number; end?: number }

type BlockItem =
  | { type: "text" }
  | { type: "reasoning"; time?: { created: number; completed?: number } }
  | { type: "tool"; time: { created: number; completed?: number } }

/**
 * Elapsed interval for a text block.
 *
 * `ordinal` is the text block's position among the message's text parts (the
 * same ordinal the part id ends with), not its index in `content`: reasoning and
 * tool blocks sit between text blocks.
 *
 * Text parts carry no timestamps of their own, so the interval runs from the
 * previous block's end (or the message start) to the next block's start (or the
 * message's streamed/completed time). Reasoning, text, and tool blocks therefore
 * tile the message without gaps, and their durations sum to the message total.
 */
export function textBlockTime(
  message: { time: { created: number; streamed?: number; completed?: number }; content: ReadonlyArray<BlockItem> },
  ordinal: number,
  now: number,
): BlockTime | undefined {
  const content = message.content
  const index = textContentIndex(content, ordinal)
  if (index < 0) return undefined
  const previous = content[index - 1]
  const next = content[index + 1]
  const start = previous ? (blockEnd(previous) ?? now) : message.time.created
  const end = next ? (blockStart(next) ?? now) : (message.time.streamed ?? message.time.completed ?? now)
  return { start, end }
}

function textContentIndex(content: ReadonlyArray<BlockItem>, ordinal: number) {
  let seen = -1
  for (let index = 0; index < content.length; index++) {
    if (content[index]?.type !== "text") continue
    seen++
    if (seen === ordinal) return index
  }
  return -1
}

function blockStart(item: BlockItem) {
  if (item.type === "tool") return item.time.created
  if (item.type === "reasoning") return item.time?.created
  return undefined
}

function blockEnd(item: BlockItem) {
  if (item.type === "tool") return item.time.completed
  if (item.type === "reasoning") return item.time?.completed
  return undefined
}
