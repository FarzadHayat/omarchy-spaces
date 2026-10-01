// Spaces agent reporter for omp (oh-my-pi).
//
// Tells the Spaces bar widget what this omp session is doing, so a terminal
// running omp gets the same badge a Claude Code or opencode terminal gets.
//
//   working  the agent is running
//   waiting  the agent needs an answer
//   done     the agent finished its turn
//   end      the session is gone
//
// Reports go out through the same omarchy-shell entry point the Claude Code
// hook uses, so the widget side needs no omp-specific code:
//
//   omarchy-shell tornikegomareli.spaces agent <session> <state> <pids>
//
// The pid list is this process and its ancestors; the widget matches them
// against terminal windows to find which one to badge.
//
// Install by adding the installed plugin's copy to your omp config, so
// `omarchy plugin update` keeps the reporter current:
//
//   # ~/.omp/agent/config.yml
//   extensions:
//     - ~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/omp-extension.js
//
// State decisions live in opencode-state.js, which is pure and unit tested.

import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { WAIT_DELAY, needsWaitTimer, reduce } from "./opencode-state.js"

const PLUGIN_ID = "tornikegomareli.spaces"

// omp brackets every agent loop iteration with turn_start/turn_end, so
// turn_end fires after each tool batch -- not once per prompt. Mapping it to
// "done" would flash a check mark five times during a five-round-trip prompt.
// The end of the whole turn is agent_end, and even that is only terminal when
// isTerminal is not false (session_stop continuations carry isTerminal: false
// and the agent keeps going).
export function ompSignal(event) {
  switch (event && event.type) {
    case "agent_start":
    case "turn_start":
    case "auto_retry_start":
      return "busy"
    case "tool_execution_end":
      // The `ask` tool owns the whole interactive dialog, so its end means
      // "replied", not "a tool finished".
      return event.toolName === "ask" ? null : "tool"
    case "agent_end":
      return event.isTerminal === false ? "busy" : "idle"
    default:
      return null
  }
}

// Waiting is tracked per toolCallId: omp reports an approval twice (the ask
// tool execution and the approval request) for one prompt, so counting both
// would need two replies to clear and wedge the badge on "waiting". Every
// relevant event carries toolCallId; `bare` only covers the id-less case.
export function notePending(prev, key) {
  const state = prev || { keys: [], bare: 0 }
  if (key == null) {
    return { state: { keys: state.keys, bare: state.bare + 1 }, added: true }
  }
  if (state.keys.includes(key)) {
    return { state, added: false }
  }
  return { state: { keys: [...state.keys, key], bare: state.bare }, added: true }
}

export function clearPending(prev, key) {
  const state = prev || { keys: [], bare: 0 }
  if (key == null) {
    return {
      state: { keys: state.keys, bare: Math.max(0, state.bare - 1) },
      cleared: true,
    }
  }
  if (!state.keys.includes(key)) return { state, cleared: false }
  return {
    state: { keys: state.keys.filter((k) => k !== key), bare: state.bare },
    cleared: true,
  }
}

function parentPid(pid) {
  // /proc/<pid>/stat field 4 is ppid, but the comm field can contain spaces
  // and parens, so cut everything up to the closing paren first.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim()
    return Number(rest.split(" ")[1]) || 0
  } catch {
    return 0
  }
}

// This process plus every ancestor, so the widget can walk back to the
// terminal window that owns us. Cached: the tree does not change under us.
function pidChain(pid = process.pid) {
  const chain = []
  let current = pid
  while (current > 1) {
    chain.push(current)
    const next = parentPid(current)
    if (!next || next === current) break
    current = next
  }
  return chain
}

function send(session, state, pids) {
  if (!session || !state) return
  try {
    // Detached and unref'd: the agent never waits on the bar, and the bar
    // never waits on the agent. Failures here are not the agent's problem.
    const child = spawn("omarchy-shell", [PLUGIN_ID, "agent", String(session), state, pids.join(",")], {
      detached: true,
      stdio: "ignore",
    })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

// Synchronous twin for the exit handler: async work never flushes after
// "exit", so the last "end" report must block.
function sendSync(session, state, pids) {
  if (!session || !state) return
  try {
    spawnSync("omarchy-shell", [PLUGIN_ID, "agent", String(session), state, pids.join(",")], {
      stdio: "ignore",
    })
  } catch {}
}

export default function spacesAgentReporter(pi) {
  // Subagents share this process and its pid chain, so only the main session
  // reports. The owner guard keeps a rebound factory from registering every
  // handler twice when a subagent session re-runs it.
  const selfPid = String(process.pid)
  if (process.env.SPACES_OMP_AGENT_OWNED === selfPid) return
  process.env.SPACES_OMP_AGENT_OWNED = selfPid

  const pids = pidChain()
  const sessions = new Map()
  const timers = new Map()
  const pending = new Map()

  function cancel(session, ctx) {
    const timer = timers.get(session)
    if (timer) {
      // A handler-context timer, never a raw one: a throw from a raw timer
      // callback is fatal to the whole omp session.
      if (ctx) ctx.clearTimer(timer)
      timers.delete(session)
    }
  }

  function apply(session, signal, ctx) {
    if (!session) return
    const next = reduce(sessions.get(session), signal)
    sessions.set(session, next)

    if (needsWaitTimer(next)) {
      if (!timers.has(session) && ctx) {
        timers.set(
          session,
          ctx.setTimeout(() => {
            timers.delete(session)
            apply(session, "timer", ctx)
          }, WAIT_DELAY),
        )
      }
    } else {
      cancel(session, ctx)
    }

    if (next.emit) send(session, next.emit, pids)
  }

  function noteWait(session, key, ctx) {
    if (!session) return
    const { state, added } = notePending(pending.get(session), key)
    pending.set(session, state)
    if (added) apply(session, "permission", ctx)
  }

  function clearWait(session, key, ctx) {
    if (!session) return
    const { state, cleared } = clearPending(pending.get(session), key)
    if (!cleared) return
    pending.set(session, state)
    apply(session, "replied", ctx)
  }

  function forgetWait(session) {
    pending.delete(session)
  }

  function on(handle) {
    return (event, ctx) => {
      // Subagent sessions run in this same process, so their reports would
      // overwrite the main session's badge under the same pid chain.
      if (!ctx || !ctx.agent || ctx.agent.kind !== "main") return
      try {
        handle(event, ctx)
      } catch {}
    }
  }

  pi.on("session_start", on((_event, ctx) => {
    const session = ctx.sessionManager.getSessionId()
    if (!session) return
    // Nothing is reported yet: a badge that appeared here would outlive a
    // prompt-less launch. The map only records which sessions to clean up.
    sessions.set(session, undefined)
    pending.set(session, { keys: [], bare: 0 })
  }))

  pi.on("agent_start", on((_event, ctx) => {
    apply(ctx.sessionManager.getSessionId(), "busy", ctx)
  }))

  pi.on("turn_start", on((event, ctx) => {
    apply(ctx.sessionManager.getSessionId(), ompSignal(event), ctx)
  }))

  pi.on("auto_retry_start", on((event, ctx) => {
    apply(ctx.sessionManager.getSessionId(), ompSignal(event), ctx)
  }))

  pi.on("tool_execution_start", on((event, ctx) => {
    if (event.toolName !== "ask") return
    noteWait(ctx.sessionManager.getSessionId(), event.toolCallId, ctx)
  }))

  pi.on("tool_execution_end", on((event, ctx) => {
    const session = ctx.sessionManager.getSessionId()
    // A tool finishing also retires any approval it was waiting on:
    // tool_approval_resolved is only emitted when an approval handler is
    // registered, so a policy-prompted tool would otherwise pin the badge on
    // "waiting" forever. clearWait is a no-op for a key it never recorded.
    clearWait(session, event.toolCallId, ctx)
    apply(session, ompSignal(event), ctx)
  }))

  pi.on("tool_approval_requested", on((event, ctx) => {
    noteWait(ctx.sessionManager.getSessionId(), event.toolCallId, ctx)
  }))

  pi.on("tool_approval_resolved", on((event, ctx) => {
    clearWait(ctx.sessionManager.getSessionId(), event.toolCallId, ctx)
  }))

  pi.on("agent_end", on((event, ctx) => {
    apply(ctx.sessionManager.getSessionId(), ompSignal(event), ctx)
  }))

  // The probe only reaps a badge whose pid is dead, and a switched-away
  // session's pid is still alive, so its badge would stick forever.
  pi.on("session_switch", on((event, ctx) => {
    const previous = event && event.previousSessionId
    if (!previous) return
    cancel(previous, ctx)
    forgetWait(previous)
    sessions.delete(previous)
    send(previous, "end", pids)
  }))

  pi.on("session_shutdown", on((_event, ctx) => {
    for (const [session] of sessions) {
      cancel(session, ctx)
      forgetWait(session)
      send(session, "end", pids)
    }
    sessions.clear()
    pending.clear()
  }))

  // Hard-exit net: async spawns never flush inside an exit handler, so the
  // last "end" has to block. session_shutdown already emptied `sessions`, so
  // this loop is empty on a normal quit.
  process.once("exit", () => {
    for (const [session] of sessions) {
      cancel(session)
      sendSync(session, "end", pids)
    }
  })
}
