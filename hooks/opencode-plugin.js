// Spaces agent reporter for opencode.
//
// Tells the Spaces bar widget what this opencode session is doing, so a terminal
// running opencode gets the same badge a Claude Code terminal gets.
//
//   working  the agent is running
//   waiting  the agent needs an answer
//   done     the agent finished its turn
//   end      the session is gone
//
// Reports go out through the same omarchy-shell entry point the Claude Code
// hook uses, so the widget side needs no opencode-specific code:
//
//   omarchy-shell tornikegomareli.spaces agent <session> <state> <pids>
//
// The pid list is this process and its ancestors; the widget matches them
// against terminal windows to find which one to badge.
//
// Install either from npm:
//
//   {
//     "$schema": "https://opencode.ai/config.json",
//     "plugin": ["opencode-spaces"]
//   }
//
// or, to run this exact checkout (repo stays the single source of truth,
// no copy to keep in sync):
//
//   {
//     "$schema": "https://opencode.ai/config.json",
//     "plugin": ["file:///path/to/omarchy-spaces/hooks/opencode-plugin.js"]
//   }
//
// Then `omarchy-shell shell rescanPlugins` if the bar is running.
//
// State decisions live in opencode-state.js, which is pure and unit tested.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { WAIT_DELAY, needsWaitTimer, reduce } from "./opencode-state.js"

const PLUGIN_ID = "tornikegomareli.spaces"

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

export const SpacesAgent = async () => {
  const pids = pidChain()
  const sessions = new Map()
  const timers = new Map()

  function cancel(session) {
    const timer = timers.get(session)
    if (timer) {
      clearTimeout(timer)
      timers.delete(session)
    }
  }

  function apply(session, signal) {
    if (!session) return
    const next = reduce(sessions.get(session), signal)
    sessions.set(session, next)

    if (needsWaitTimer(next)) {
      if (!timers.has(session)) {
        timers.set(
          session,
          setTimeout(() => {
            timers.delete(session)
            apply(session, "timer")
          }, WAIT_DELAY),
        )
      }
    } else {
      cancel(session)
    }

    if (next.emit) send(session, next.emit, pids)
  }

  // opencode reports permission requests twice over: the `permission.ask` hook
  // and a `permission.updated` / `permission.asked` event. Either is enough,
  // and `replied` is what clears the pending count, so a duplicate is safe.
  function normalize(type, properties = {}) {
    const session = properties.sessionID
    if (!session) return
    switch (type) {
      case "permission.updated":
      case "permission.asked":
        apply(session, "permission")
        break
      case "permission.replied":
        apply(session, "replied")
        break
      case "session.status":
        if (properties.status && properties.status.type !== "idle") apply(session, "busy")
        break
      case "session.idle":
        apply(session, "idle")
        break
      case "session.deleted":
        cancel(session)
        sessions.delete(session)
        send(session, "end", pids)
        break
    }
  }

  // dispose covers a normal quit. This is the net for a hard exit, where the
  // bar would otherwise keep a stale "working" badge on a dead window.
  process.once("exit", () => {
    for (const [session] of sessions) {
      cancel(session)
      send(session, "end", pids)
    }
  })

  return {
    event: async ({ event } = {}) => {
      if (!event) return
      try {
        normalize(event.type, event.properties)
      } catch {}
    },

    "chat.message": async (input) => {
      apply(input && input.sessionID, "prompt")
    },

    "tool.execute.after": async (input) => {
      apply(input && input.sessionID, "tool")
    },

    "permission.ask": async (input, output) => {
      if (output && output.status !== "ask") return
      apply(input && input.sessionID, "permission")
    },

    dispose: async () => {
      for (const [session] of sessions) {
        cancel(session)
        send(session, "end", pids)
      }
      sessions.clear()
    },
  }
}
