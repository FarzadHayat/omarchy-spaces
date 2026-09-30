// Run: node tests/omp-extension.test.js
//
// The event mapping in hooks/omp-extension.js and the state machine in
// hooks/opencode-state.js decide what the Spaces bar shows. Both are pure, so
// they are tested here with no omp and no processes.
const path = require("path")
const assert = require("assert")
const { pathToFileURL } = require("url")

let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log("ok   " + name)
  } catch (e) {
    failed++
    console.log("FAIL " + name + "\n     " + e.message)
  }
}

function main() {
  const base = path.join(__dirname, "..", "hooks")
  const ext = pathToFileURL(path.join(base, "omp-extension.js")).href
  const state = pathToFileURL(path.join(base, "opencode-state.js")).href

  return Promise.all([import(ext), import(state)]).then(([E, S]) => {
    const INITIAL_PENDING = { keys: [], bare: 0 }

    // Drive a signal sequence and collect everything the extension would
    // report, exactly as the factory's apply() does.
    function run(signals) {
      const emitted = []
      let prev
      for (const signal of signals) {
        const next = S.reduce(prev, signal)
        prev = next
        if (next.emit) emitted.push(next.emit)
      }
      return { emitted, state: prev }
    }

    test("agent_start reports busy", () => {
      assert.strictEqual(E.ompSignal({ type: "agent_start" }), "busy")
    })

    test("turn_start reports busy", () => {
      assert.strictEqual(E.ompSignal({ type: "turn_start" }), "busy")
    })

    // The upstream support plan mapped turn_end to done. turn_start/turn_end
    // bracket every agent loop iteration, so a five-round-trip prompt would
    // flash five check marks. agent_end is the real end of turn.
    test("turn_end reports nothing", () => {
      assert.strictEqual(E.ompSignal({ type: "turn_end" }), null)
    })

    test("a terminal agent_end reports idle", () => {
      assert.strictEqual(E.ompSignal({ type: "agent_end" }), "idle")
    })

    test("an explicit terminal agent_end reports idle", () => {
      assert.strictEqual(E.ompSignal({ type: "agent_end", isTerminal: true }), "idle")
    })

    // session_stop continuations keep the agent running, so the badge must
    // not flip to done mid-work.
    test("a non-terminal agent_end reports busy", () => {
      assert.strictEqual(E.ompSignal({ type: "agent_end", isTerminal: false }), "busy")
    })

    test("a finished tool reports tool", () => {
      assert.strictEqual(E.ompSignal({ type: "tool_execution_end", toolName: "bash" }), "tool")
    })

    test("a retry reports busy", () => {
      assert.strictEqual(E.ompSignal({ type: "auto_retry_start" }), "busy")
    })

    // ask goes through the pending path so the badge survives the dialog.
    test("the ask tool does not report through the event map", () => {
      assert.strictEqual(E.ompSignal({ type: "tool_execution_start", toolName: "ask" }), null)
      assert.strictEqual(E.ompSignal({ type: "tool_execution_end", toolName: "ask" }), null)
    })

    test("missing and unknown events report nothing", () => {
      assert.strictEqual(E.ompSignal({}), null)
      assert.strictEqual(E.ompSignal(null), null)
      assert.strictEqual(E.ompSignal(undefined), null)
      assert.strictEqual(E.ompSignal({ type: "nope" }), null)
    })

    // omp reports one approval twice: the ask execution and the approval
    // request. Counting both would need two replies to clear the badge.
    test("a duplicate toolCallId is not counted twice", () => {
      const once = E.notePending(INITIAL_PENDING, "t1")
      const twice = E.notePending(once.state, "t1")
      assert.strictEqual(once.added, true)
      assert.strictEqual(twice.added, false)
      assert.deepStrictEqual(twice.state.keys, ["t1"])
    })

    test("clearing an unknown toolCallId clears nothing", () => {
      const pending = E.notePending(INITIAL_PENDING, "t1")
      const out = E.clearPending(pending.state, "other")
      assert.strictEqual(out.cleared, false)
      assert.deepStrictEqual(out.state, pending.state)
    })

    test("id-less events use a separate counter", () => {
      const once = E.notePending(INITIAL_PENDING, null)
      const twice = E.notePending(once.state, undefined)
      assert.strictEqual(once.added, true)
      assert.strictEqual(twice.added, true)
      assert.strictEqual(twice.state.bare, 2)
    })

    test("the id-less counter never goes negative", () => {
      const out = E.clearPending(INITIAL_PENDING, null)
      assert.strictEqual(out.cleared, true)
      assert.strictEqual(out.state.bare, 0)
    })

    test("pending helpers do not mutate their input", () => {
      const prev = E.notePending(INITIAL_PENDING, "t1").state
      const snapshot = JSON.parse(JSON.stringify(prev))
      E.notePending(prev, "t2")
      E.clearPending(prev, "t1")
      E.clearPending(prev, null)
      assert.deepStrictEqual(prev, snapshot)
    })

    // The regression that drove this design: five turn_end events, one done.
    test("a two-iteration prompt reports working then done", () => {
      const signals = [
        E.ompSignal({ type: "agent_start" }),
        E.ompSignal({ type: "turn_start" }),
        E.ompSignal({ type: "turn_end" }),
        E.ompSignal({ type: "turn_start" }),
        E.ompSignal({ type: "turn_end" }),
        E.ompSignal({ type: "tool_execution_end", toolName: "bash" }),
        E.ompSignal({ type: "agent_end" }),
      ].filter((s) => s !== null)
      assert.deepStrictEqual(run(signals).emitted, ["working", "done"])
    })

    test("an ask dialog reports waiting after the debounce", () => {
      const { emitted, state } = run(["busy", "permission", "timer", "replied", "idle"])
      assert.deepStrictEqual(emitted, ["working", "waiting", "working", "done"])
      assert.strictEqual(state.pending, 0)
    })

    // A turn that ends while the agent still waits must not report done.
    test("a turn ending on an open ask does not report done", () => {
      const { emitted, state } = run(["busy", "permission", "idle"])
      assert.deepStrictEqual(emitted, ["working"])
      assert.strictEqual(state.want, "waiting")
    })

    test("WAIT_DELAY is long enough to skip an instant answer", () => {
      assert.ok(S.WAIT_DELAY >= 1000, "debounce under 1s would strobe on a quick approval")
    })

    process.exit(failed ? 1 : 0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
