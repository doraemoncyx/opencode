import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { computeStats, deriveActivity, formatActivity, formatStats } from "./activity-model"

function useNow() {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

export function ActivityLine(props: {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  kind: "activity" | "stats"
}) {
  const now = useNow()
  const text = createMemo(() => {
    const sessionID = props.sessionID
    if (props.mode !== "normal" || !sessionID) return
    const messages = props.context.data.session.message.list(sessionID)
    if (props.kind === "stats") {
      const stats = computeStats(messages, Math.max(Date.now(), now()))
      return stats ? formatStats(stats) : undefined
    }
    const activity = deriveActivity(messages, {
      running: props.context.data.session.status(sessionID) === "running",
      queued: props.context.data.session.pending.list(sessionID).filter((item) => item.type === "user").length,
    })
    return activity ? formatActivity(activity, now()) : undefined
  })

  return (
    <Show when={text()}>
      {(value) => (
        <text fg={props.context.theme.text.subdued} wrapMode="none" truncate>
          {value()}
        </text>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.prompt.activity",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <ActivityLine context={context} sessionID={props.sessionID} mode={props.mode} kind="activity" />,
    })
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => <ActivityLine context={context} sessionID={props.sessionID} mode={props.mode} kind="stats" />,
    })
  },
})
