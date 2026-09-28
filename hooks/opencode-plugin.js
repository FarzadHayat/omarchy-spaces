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
// Install by linking the installed plugin's copy into OpenCode, so
// `omarchy plugin update` keeps the reporter current:
//
//   ln -sfn ~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/opencode-plugin.js \
//           ~/.config/opencode/plugins/spaces.js
//
// State decisions live in opencode-state.js, which is pure and unit tested.

import { spawn, spawnSync } from "node:child_process"
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

export const SpacesAgent = async () => {
  const pids = pidChain()
  const sessions = new Map()
  const timers = new Map()
  // Seen permission request ids per session, and id-less hook reports still
  // waiting for their event twin. opencode reports each permission twice:
  // the `permission.ask` hook fires first, then the `permission.asked` event
  // for the same request. Counting both would need two replies for one
  // prompt and wedge the badge on "waiting".
  const permIds = new Map()
  const permBare = new Map()

  function forgetPermission(session) {
    permIds.delete(session)
    permBare.delete(session)
  }

  function notePermission(session, id) {
    if (id == null) {
      permBare.set(session, (permBare.get(session) || 0) + 1)
      apply(session, "permission")
      return
    }
    let ids = permIds.get(session)
    if (!ids) {
      ids = new Set()
      permIds.set(session, ids)
    }
    if (ids.has(id)) return
    ids.add(id)
    const bare = permBare.get(session) || 0
    if (bare > 0) {
      // The id-less hook report just before this event was the same request:
      // adopt its pending count instead of counting a second prompt.
      if (bare === 1) permBare.delete(session)
      else permBare.set(session, bare - 1)
      return
    }
    apply(session, "permission")
  }

  function noteReplied(session, id) {
    if (id != null) {
      const ids = permIds.get(session)
      if (ids) {
        ids.delete(id)
        if (!ids.size) permIds.delete(session)
      }
    } else {
      const bare = (permBare.get(session) || 0) - 1
      if (bare <= 0) permBare.delete(session)
      else permBare.set(session, bare)
    }
    apply(session, "replied")
  }

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

  function normalize(type, properties = {}) {
    const session = properties.sessionID
    if (!session) return
    switch (type) {
      case "permission.updated":
      case "permission.asked":
        notePermission(session, properties.id)
        break
      case "permission.replied":
        noteReplied(session, properties.requestID)
        break
      case "session.status":
        if (properties.status && properties.status.type !== "idle") apply(session, "busy")
        break
      case "session.idle":
        apply(session, "idle")
        break
      case "session.deleted":
        cancel(session)
        forgetPermission(session)
        sessions.delete(session)
        send(session, "end", pids)
        break
    }
  }

  // dispose covers a normal quit. This is the net for a hard exit, where the
  // bar would otherwise keep a stale "working" badge on a dead window.
  // Synchronous: async spawns never flush inside an exit handler.
  process.once("exit", () => {
    for (const [session] of sessions) {
      cancel(session)
      sendSync(session, "end", pids)
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
      // input.id is optional in older opencode; without it the request still
      // counts, and its event twin adopts the count when it arrives with one.
      notePermission(input && input.sessionID, input && input.id)
    },

    dispose: async () => {
      for (const [session] of sessions) {
        cancel(session)
        forgetPermission(session)
        send(session, "end", pids)
      }
      sessions.clear()
    },
  }
}
