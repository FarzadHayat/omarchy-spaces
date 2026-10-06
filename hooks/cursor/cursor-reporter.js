#!/usr/bin/env node
// Spaces agent reporter for Cursor.
//
// Tells the Spaces bar widget what this Cursor agent session is doing, so a
// Cursor window (or a terminal running cursor-agent) gets the same badge a
// Claude Code terminal gets.
//
//   working  the agent is running
//   done     the agent finished its turn
//   end      the conversation is gone
//
// Reports go out through the same omarchy-shell entry point the Claude Code
// hook uses, so the widget side needs no Cursor-specific code:
//
//   omarchy-shell tornikegomareli.spaces agent <session> <state> <pids>
//
// The pid list starts at the agent process (the Cursor window, or the node
// process running cursor-agent) and continues up its ancestors; the widget
// matches them against windows to find which one to badge. Starting at the
// agent matters: the widget reaps a badge whose first pid has exited, and this
// reporter is a one-shot process that exits the moment it reports.
//
// Register in ~/.cursor/hooks.json (covers both the IDE and cursor-agent):
//
//   {
//     "version": 1,
//     "hooks": {
//       "beforeSubmitPrompt":   [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "sessionStart":         [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "preToolUse":           [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "beforeShellExecution": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "afterShellExecution":  [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "afterFileEdit":        [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "postToolUse":          [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "afterAgentThought":    [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
//       "stop":                 [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10, "loop_limit": null }],
//       "sessionEnd":           [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }]
//     }
//   }
//
// The reporter ships with the plugin, so `omarchy plugin update
// tornikegomareli.spaces` keeps it current; there is no npm package.
//
// The stop entry needs "loop_limit": null: Cursor disables stop hooks after 5
// runs by default, which would silently kill the reporter mid-session.
//
// State decisions live in cursor-state.js, which is pure and unit tested.

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasPendingTurn, reportablePids, sessionKey, stateForEvent, supersededSubmits, trackedId } from "./cursor-state.js"

const PLUGIN_ID = "tornikegomareli.spaces"

function parentPid(pid) {
  // /proc/<pid>/stat field 4 is ppid, but the comm field can contain spaces
  // and parens, so cut everything up to the closing paren first.
  // (Same walk as the opencode reporter: the tree shape is what matters.)
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim()
    return Number(rest.split(" ")[1]) || 0
  } catch {
    return 0
  }
}

// This process plus every ancestor, so the widget can walk back to the
// Cursor window or terminal that owns us.
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

// Read the few /proc fields the pid selection needs. Any of them may be
// missing for a process that already exited; the selectors tolerate that.
function procInfo(pid) {
  let comm = ""
  try {
    comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
  } catch {}
  let cmdline = []
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  } catch {}
  let exe = ""
  try {
    exe = readlinkSync(`/proc/${pid}/exe`)
  } catch {}
  return { pid, comm, cmdline, exe }
}

// The list to report, agent first: this process and its ancestors, but
// starting at a long-lived Cursor/cursor-agent process. The widget reaps a
// badge whose first pid is dead, and this hook is a one-shot that exits the
// moment it reports, so the hook itself must never be first.
function reportPids() {
  return reportablePids(pidChain().map(procInfo))
}

// Synchronous: this process exits as soon as stdin ends, so an async spawn
// might never flush. Failures here are not the agent's problem.
function send(session, state, pids) {
  if (!session || !state) return
  try {
    spawnSync("omarchy-shell", [PLUGIN_ID, "agent", String(session), state, pids.join(",")], {
      stdio: "ignore",
    })
  } catch {}
}

// Per-user ledger location. XDG_RUNTIME_DIR is private (mode 0700), unlike
// the shared /tmp, so another local user cannot pre-create the path and have
// sweepSessions delete through a symlink they planted.
function baseDir() {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) return join(runtime, "cursor-spaces")
  const dir = join(tmpdir(), `cursor-spaces-${process.getuid()}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
  return dir
}

// Per-session turn ledger, so a stop only reports done when no submitted
// turn is still unstopped (queued prompts start silently). One empty file
// per turn id under submitted/ or stopped/: creating a file is atomic, so
// concurrent hook runs cannot lose an update the way read-modify-write of a
// single JSON file could.
function sessionDir(session) {
  const safe = String(session || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")
  return join(baseDir(), safe)
}

function listIds(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function listEntries(dir) {
  try {
    return readdirSync(dir).map((id) => ({ id, mtimeMs: statSync(join(dir, id)).mtimeMs }))
  } catch {
    return []
  }
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_")
}

// A stop for the running turn means every earlier submit is either stopped or
// was abandoned; drop the abandoned ones so a never-stopped submit cannot hold
// "done" forever. Queued follow-ups were submitted after this turn began, so
// they are newer and survive.
function dropSuperseded(base, stoppingId) {
  const submittedDir = join(base, "submitted")
  for (const id of supersededSubmits(listEntries(submittedDir), safeId(stoppingId))) {
    try {
      rmSync(join(submittedDir, id), { force: true })
    } catch {}
  }
}

function trackTurn(session, turn, id) {
  if (!id) return false
  try {
    const base = sessionDir(session)
    const dir = join(base, turn)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, safeId(id)), "")
    if (turn === "stopped") dropSuperseded(base, id)
    sweepSessions()
    return hasPendingTurn(listIds(join(base, "submitted")), listIds(join(base, "stopped")))
  } catch {
    return false
  }
}

function forgetSession(session) {
  try {
    rmSync(sessionDir(session), { recursive: true, force: true })
  } catch {}
}

// Sessions whose agent died mid-queue never send sessionEnd; drop ledgers
// older than a day so they do not accumulate.
function sweepSessions() {
  try {
    const root = baseDir()
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const entry of listIds(root)) {
      const dir = join(root, entry)
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}

function main() {
  let raw = ""
  try {
    raw = readFileSync(0, "utf8")
  } catch {}
  // Observational hook: never block the agent loop, whatever stdin holds.
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = {}
  }
  const event = payload.hook_event_name || payload.hook_event || payload.event || ""
  const state = stateForEvent(event)
  if (!state) return
  const session = sessionKey(payload)
  if (event === "sessionEnd") {
    forgetSession(session)
    send(session, state, reportPids())
    return
  }
  if (event === "beforeSubmitPrompt" || event === "stop") {
    const turn = state === "done" ? "stopped" : "submitted"
    if (trackTurn(session, turn, trackedId(payload)) && state === "done") {
      // A queued follow-up is still unstopped: its start emits nothing, so
      // reporting done now would stick until late in that turn. Hold.
      return
    }
  }
  send(session, state, reportPids())
}

main()
// Cursor ignores stdout on observational hooks; an empty object keeps the
// contract explicit on the off chance it ever looks.
process.stdout.write("{}\n")
