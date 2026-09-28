// Pure state machine for the opencode agent reporter (see opencode-plugin.js).
//
// No IO, no opencode imports: the plugin normalizes opencode hooks and events
// into the small signal vocabulary below, and this file decides what the Spaces
// bar should be told. Exercised by node (see tests/opencode-plugin.test.js).
//
// Signals (from opencode, already normalized by the plugin):
//   "prompt"    a new user message arrived
//   "tool"      a tool finished
//   "busy"      session status became busy or retry
//   "permission"  a permission request is pending
//   "replied"   a permission request was answered
//   "idle"      the session stopped working
//   "deleted"   the session was deleted
//   "end"       the process is going away
//   "timer"     the waiting debounce elapsed
//
// State per session:
//   state    the last state reported to the bar
//   pending  unanswered permission requests
//   want     the state the bar should show once the debounce settles
//
// Two rules earn their keep:
//   1. A pending permission outranks everything. Otherwise `idle` fires while
//      opencode waits for a yes/no answer and the badge shows a check mark for
//      an agent that is actually blocked.
//   2. "waiting" only reports after the debounce. opencode --auto answers a
//      permission in milliseconds; without the delay the badge strobes.

export const WAIT_DELAY = 1500

export const INITIAL = { state: "", pending: 0, want: "", emit: "" }

// No change to report. Rebuilt fresh so a previous emit is never replayed.
function hold(state) {
  return { state: state.state, pending: state.pending, want: state.want, emit: "" }
}

export function reduce(prev, signal) {
  const base = prev || INITIAL
  if (base.state === "end") return hold(base)

  let state = base.state
  let pending = base.pending
  let want = base.want

  switch (signal) {
    case "prompt":
    case "tool":
    case "busy":
      // A permission is still unanswered, so the agent still needs the user.
      if (pending > 0) return hold(base)
      want = "working"
      break

    case "permission":
      pending++
      want = "waiting"
      break

    case "replied":
      // An unmatched reply answers nothing: hold instead of inventing work.
      if (pending === 0) return hold(base)
      pending--
      want = pending > 0 ? "waiting" : "working"
      break

    case "idle":
      want = pending > 0 ? "waiting" : "done"
      break

    case "timer":
      // Only the debounced wait may promote "waiting" to a reported state.
      if (want !== "waiting" || pending === 0) return hold(base)
      return { state: "waiting", pending, want, emit: "waiting" }

    case "deleted":
    case "end":
      return { state: "end", pending, want: "", emit: "end" }

    default:
      return hold(base)
  }

  // "waiting" is held back for the debounce; everything else reports at once.
  if (!want || want === state || want === "waiting") return hold({ state, pending, want })
  return { state: want, pending, want, emit: want }
}

// True while a session wants a "waiting" badge that the debounce has not
// confirmed yet, so the caller knows to (re)arm the timer.
export function needsWaitTimer(next) {
  return next.want === "waiting" && next.state !== "waiting"
}
