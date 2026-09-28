// Run: node tests/opencode-plugin.test.js
//
// The state machine in hooks/opencode-state.js decides what the Spaces bar
// shows. It is pure, so it is tested here with no opencode and no processes.
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
  const file = pathToFileURL(path.join(__dirname, "..", "hooks", "opencode-state.js")).href
  return import(file).then((M) => {
    // Drive a signal sequence and collect everything the plugin would report.
    function run(signals) {
      const emitted = []
      let state
      for (const signal of signals) {
        const next = M.reduce(state, signal)
        state = next
        if (next.emit) emitted.push(next.emit)
      }
      return { emitted, state }
    }

    test("a prompt reports working", () => {
      assert.deepStrictEqual(run(["prompt"]).emitted, ["working"])
    })

    test("repeated work does not re-report", () => {
      assert.deepStrictEqual(run(["prompt", "tool", "busy", "tool"]).emitted, ["working"])
    })

    test("idle reports done", () => {
      assert.deepStrictEqual(run(["prompt", "tool", "idle"]).emitted, ["working", "done"])
    })

    test("repeated idle does not re-report done", () => {
      assert.deepStrictEqual(run(["prompt", "idle", "idle"]).emitted, ["working", "done"])
    })

    test("a new prompt after done reports working again", () => {
      assert.deepStrictEqual(run(["prompt", "idle", "prompt"]).emitted, ["working", "done", "working"])
    })

    test("a permission waits for the debounce", () => {
      const { emitted, state } = run(["prompt", "permission"])
      assert.deepStrictEqual(emitted, ["working"])
      assert.strictEqual(state.want, "waiting")
      assert.strictEqual(M.needsWaitTimer(state), true)
    })

    test("the timer promotes waiting", () => {
      const { emitted } = run(["prompt", "permission", "timer"])
      assert.deepStrictEqual(emitted, ["working", "waiting"])
    })

    test("auto-approved permissions never show waiting", () => {
      // opencode --auto answers in milliseconds, so the debounce must expire.
      // The reply still resumes work, so "working" is all that is reported.
      assert.deepStrictEqual(run(["permission", "replied", "timer"]).emitted, ["working"])
    })

    test("idle while a permission is pending does not report done", () => {
      const { emitted, state } = run(["permission", "idle"])
      assert.deepStrictEqual(emitted, [])
      assert.strictEqual(state.want, "waiting")
    })

    test("idle after the permission clears reports done", () => {
      assert.deepStrictEqual(run(["permission", "replied", "idle"]).emitted, ["working", "done"])
    })

    test("work signals do not clear a pending permission", () => {
      const { emitted, state } = run(["permission", "tool", "busy", "timer"])
      assert.deepStrictEqual(emitted, ["waiting"])
      assert.strictEqual(state.pending, 1)
    })

    test("two pending permissions need two replies", () => {
      const { state } = run(["permission", "permission", "replied"])
      assert.strictEqual(state.pending, 1)
      assert.strictEqual(state.want, "waiting")
    })

    test("waiting clears when the permission is answered", () => {
      assert.deepStrictEqual(run(["permission", "timer", "replied"]).emitted, ["waiting", "working"])
    })

    test("a stray timer does nothing", () => {
      assert.deepStrictEqual(run(["timer"]).emitted, [])
    })

    test("unknown signals are ignored", () => {
      const { emitted } = run(["whatever", 42, null, undefined, "prompt"])
      assert.deepStrictEqual(emitted, ["working"])
    })

    test("deleted and end both report end", () => {
      assert.deepStrictEqual(run(["prompt", "deleted"]).emitted, ["working", "end"])
      assert.deepStrictEqual(run(["prompt", "end"]).emitted, ["working", "end"])
    })

    test("nothing reports after end", () => {
      assert.deepStrictEqual(run(["end", "prompt", "idle"]).emitted, ["end"])
    })

    test("sessions are independent", () => {
      const a = run(["prompt", "idle"])
      const b = run(["prompt"])
      assert.deepStrictEqual(a.emitted, ["working", "done"])
      assert.deepStrictEqual(b.emitted, ["working"])
    })

    test("a fresh session starts empty", () => {
      assert.deepStrictEqual(M.reduce(undefined, "timer"), M.INITIAL)
    })

    test("WAIT_DELAY is long enough to skip an auto reply", () => {
      assert.ok(M.WAIT_DELAY >= 1000, "debounce under 1s would strobe in --auto")
    })

    process.exit(failed ? 1 : 0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
