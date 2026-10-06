// Pure mapping for the Cursor agent reporter (see cursor-reporter.js).
//
// No IO, no Cursor imports: the reporter reads one hook event from stdin,
// and this file decides which Spaces state that event means, if any.
// Exercised by node (see tests/cursor-reporter.test.js).
//
// Cursor spawns a fresh process per hook event, so there is no cross-event
// memory here. Each event maps to at most one report:
//
//   "working"  the agent started or kept working:
//              beforeSubmitPrompt, preToolUse, beforeShellExecution,
//              afterAgentThought
//   "done"     the turn reached a completion point: stop
//              (any status: completed, aborted, error). An aborted turn still
//              deserves a look, and the next prompt flips back to working.
//   "end"      the conversation closed: sessionEnd
//
// Deliberately absent: "waiting". Cursor exposes no hook for "the agent
// asked the user a question", so a waiting badge would be a guess. Also
// silent: sessionStart (a launched, idle agent is not working; Claude Code
// does not badge on SessionStart either), afterAgentResponse (fires mid-turn
// before tool calls, so reporting done there would strobe every turn),
// postToolUseFailure, preCompact, subagents, and Tab hooks.
//
// Queued prompts need more than the map above. Each submitted prompt carries
// its own generation_id, and a queued follow-up starts with no event at all:
// its beforeSubmitPrompt already fired while the previous turn was running.
// So "stop" only means "done" when every submitted generation has stopped.
// The reporter persists the two id sets per session (one file per id, so
// concurrent hook runs cannot lose an update) and asks hasPendingTurn
// before reporting done:

// trackedId returns the turn id carried by submit/stop events, or "" when
// the payload has none (older payloads, mid-session installs).
export function trackedId(payload = {}) {
  return payload.generation_id || ""
}

// hasPendingTurn is true while a submitted turn has no matching stop.
// A stop for an untracked turn (hook installed mid-session) leaves no
// pending turn, so it still reports done exactly once.
export function hasPendingTurn(submitted, stopped) {
  const done = new Set(stopped)
  return submitted.some((id) => !done.has(id))
}

// supersededSubmits returns submitted turn ids that can no longer be pending:
// they were submitted before the turn that just stopped began. A queued
// follow-up is submitted after the running turn started, so its submit file is
// newer than the stopping turn's and it survives. This heals a submit that
// never gets a stop (an aborted or superseded prompt): without it such an
// orphan stays pending forever and holds "done" for the rest of the session.
// entries are { id, mtimeMs } for one session's submitted turns.
export function supersededSubmits(entries = [], stoppingId = "") {
  const pivot = entries.find((e) => e.id === stoppingId)
  if (!pivot) return []
  return entries
    .filter((e) => e.id !== stoppingId && e.mtimeMs <= pivot.mtimeMs)
    .map((e) => e.id)
}

// Events that mean the agent is (still) working.
const WORKING = new Set([
  "beforeSubmitPrompt",
  "preToolUse",
  "beforeShellExecution",
  "afterAgentThought",
  // Tool completions also mean working. cursor-agent in a terminal never
  // fires beforeSubmitPrompt for queued follow-ups, so without these the
  // badge sits on done until late in the next turn, then flickers
  // working -> done. Any tool activity restarts the working signal instead.
  "postToolUse",
  "afterShellExecution",
  "afterFileEdit",
])

// stateForEvent returns "working", "done", "end", or "" to stay silent.
export function stateForEvent(eventName) {
  if (!eventName) return ""
  if (WORKING.has(eventName)) return "working"
  if (eventName === "stop") return "done"
  if (eventName === "sessionEnd") return "end"
  return ""
}

// sessionKey returns a stable id for the conversation the event belongs to,
// so the widget badges one entry per chat. conversation_id and session_id
// are the same identifier; transcript_path is per-conversation, so it works
// as a fallback where the ids are missing. workspace_roots is not used: every
// chat in a folder would share one badge and one turn ledger.
export function sessionKey(payload = {}) {
  return payload.conversation_id || payload.session_id || payload.transcript_path || ""
}

// --- Which pids to report ----------------------------------------------------
//
// The widget reaps a working/done badge whose first reported pid is no longer
// alive, so the list must start at a long-lived agent process. Cursor spawns
// the reporter as a one-shot process that exits the moment it reports, so the
// reporter itself (and any shell wrapper between it and the agent) must not be
// first. These helpers pick the start of the list from a chain of plain
// process descriptors, so the choice is unit tested without reading /proc.

// isAgentProcess: a Cursor window (the IDE's main process) or the node process
// running cursor-agent. Either outlives the hook, so the reaper can see it.
// The Cursor window's command line names cursor.mjs even where the process
// title (comm) is not "cursor", so match it anywhere in argv, not just argv0.
export function isAgentProcess(proc = {}) {
  const comm = proc.comm || ""
  const argv = proc.cmdline || []
  const exe = proc.exe || ""
  return (
    comm === "cursor" ||
    comm === "cursor-agent" ||
    argv.some((arg) => /(^|\/)cursor-agent$/.test(arg)) ||
    argv.some((arg) => /(^|\/)cursor\.mjs$/.test(arg)) ||
    /(^|\/)cursor-agent$/.test(exe)
  )
}

// isShellProcess: transient wrappers to skip when no agent process is named.
export function isShellProcess(proc = {}) {
  return /^(sh|bash|dash|zsh|fish|ksh|csh|tcsh)$/.test(proc.comm || "")
}

// reportablePids returns the pids to send, agent first. It drops the reporter
// process itself, then starts at the first Cursor/cursor-agent ancestor;
// failing that, at the first non-shell ancestor, so the reaper probes a
// process that outlives the hook. Shell-only ancestors yield nothing: a
// short-lived wrapper must not be pids[0].
export function reportablePids(chain = []) {
  const ancestors = chain.slice(1)
  if (ancestors.length === 0) return chain.length ? [chain[0].pid] : []
  const agentAt = ancestors.findIndex(isAgentProcess)
  if (agentAt >= 0) return ancestors.slice(agentAt).map((p) => p.pid)
  const firstReal = ancestors.findIndex((p) => !isShellProcess(p))
  if (firstReal < 0) return []
  return ancestors.slice(firstReal).map((p) => p.pid)
}
