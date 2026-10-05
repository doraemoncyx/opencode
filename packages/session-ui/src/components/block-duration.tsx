import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useI18n } from "@opencode/ui/context/i18n"
import type { BlockTime } from "../message/block-time"

/**
 * Right-aligned elapsed time for a single timeline block.
 *
 * While `live` is true the label recomputes every second from the real wall
 * clock; once the block settles it keeps its final value. Completed blocks need
 * no timer, so the interval only runs for the block that is currently active.
 */
export function BlockDuration(props: { time: BlockTime | ((now: number) => BlockTime | undefined); live: boolean }) {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())

  createEffect(
    on(
      () => props.live,
      (live) => {
        if (!live) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
      },
    ),
  )

  const label = createMemo(() => {
    const value = typeof props.time === "function" ? props.time(now()) : props.time
    if (!value) return undefined
    const end = value.end ?? now()
    if (end < value.start) return undefined
    return formatElapsed(end - value.start, i18n)
  })

  return (
    <Show when={label()}>
      <span data-slot="block-duration">{label()}</span>
    </Show>
  )
}

const numfmtCache = new Map<string, { seconds: Intl.NumberFormat; minutes: Intl.NumberFormat }>()

function numfmtFor(locale: string) {
  const cached = numfmtCache.get(locale)
  if (cached) return cached
  const created = {
    seconds: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    minutes: new Intl.NumberFormat(locale),
  }
  numfmtCache.set(locale, created)
  return created
}

/** Shared `xx.xx s` / `Nm xx.xx s` formatting for block and turn durations. */
export function formatElapsed(ms: number, i18n: ReturnType<typeof useI18n>) {
  const numfmt = numfmtFor(i18n.locale())
  const total = Math.max(0, ms / 1000)
  if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt.seconds.format(total) })
  return i18n.t("ui.message.duration.minutesSeconds", {
    minutes: numfmt.minutes.format(Math.floor(total / 60)),
    seconds: numfmt.seconds.format(total % 60),
  })
}
