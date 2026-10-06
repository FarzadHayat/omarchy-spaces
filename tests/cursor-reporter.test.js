// Run: node tests/cursor-reporter.test.js
//
// The mapping in hooks/cursor/cursor-state.js decides what the Spaces bar
// shows for each Cursor hook event. It is pure, so it is tested here with no
// Cursor and no processes.
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
  const file = pathToFileURL(path.join(__dirname, "..", "hooks", "cursor", "cursor-state.js")).href
  return import(file).then((M) => {
    test("work events report working", () => {
      for (const event of [
        "beforeSubmitPrompt",
        "preToolUse",
        "beforeShellExecution",
        "afterAgentThought",
      ]) {
        assert.strictEqual(M.stateForEvent(event), "working", event)
      }
    })

    test("tool completions report working for queued CLI turns", () => {
      // cursor-agent never fires beforeSubmitPrompt for a queued follow-up:
      // the first sign of the next turn is a tool finishing.
      for (const event of ["postToolUse", "afterShellExecution", "afterFileEdit"]) {
        assert.strictEqual(M.stateForEvent(event), "working", event)
      }
    })

    test("stop reports done whatever the status", () => {
      // The payload status (completed/aborted/error) does not change the
      // badge: only the event name matters.
      assert.strictEqual(M.stateForEvent("stop"), "done")
    })

    test("sessionEnd reports end", () => {
      assert.strictEqual(M.stateForEvent("sessionEnd"), "end")
    })

    test("mid-turn and observer events stay silent", () => {
      // afterAgentResponse fires before tool calls, so reporting done there
      // would strobe the badge every turn.
      for (const event of [
        "sessionStart",
        "afterAgentResponse",
        "postToolUseFailure",
        "preCompact",
        "subagentStart",
        "subagentStop",
        "beforeSubmitPrompt2",
        "",
        undefined,
      ]) {
        assert.strictEqual(M.stateForEvent(event), "", String(event))
      }
    })

    test("session key prefers conversation_id", () => {
      assert.strictEqual(
        M.sessionKey({ conversation_id: "conv", session_id: "sess" }),
        "conv",
      )
    })

    test("session key falls back to session_id then transcript", () => {
      assert.strictEqual(M.sessionKey({ session_id: "sess" }), "sess")
      assert.strictEqual(M.sessionKey({ transcript_path: "/tmp/t.json" }), "/tmp/t.json")
    })

    test("session key falls back to the first workspace root", () => {
      assert.strictEqual(M.sessionKey({ workspace_roots: ["/repo", "/other"] }), "/repo")
    })

    test("session key is empty when nothing identifies the chat", () => {
      assert.strictEqual(M.sessionKey({}), "")
      assert.strictEqual(M.sessionKey(), "")
    })

    test("tracked id is the generation id", () => {
      assert.strictEqual(M.trackedId({ generation_id: "g1" }), "g1")
      assert.strictEqual(M.trackedId({}), "")
      assert.strictEqual(M.trackedId(), "")
    })

    test("a stop with nothing pending leaves no pending turn", () => {
      assert.strictEqual(M.hasPendingTurn([], []), false)
      assert.strictEqual(M.hasPendingTurn([], ["g1"]), false)
      assert.strictEqual(M.hasPendingTurn(["g1"], ["g1"]), false)
    })

    test("an unstopped submit is a pending turn", () => {
      // Two queued prompts, first turn stopped: the follow-up starts with
      // no event, so done must wait for its stop.
      assert.strictEqual(M.hasPendingTurn(["g1", "g2"], ["g1"]), true)
      assert.strictEqual(M.hasPendingTurn(["g1", "g2"], ["g1", "g2"]), false)
    })

    test("a submit older than the stopping turn is superseded", () => {
      // A prompt that never ran (aborted or superseded) must not hold done
      // forever; a queued follow-up submitted after the running turn began is
      // newer and survives, so its stop is still awaited.
      const entries = [
        { id: "old", mtimeMs: 10 },
        { id: "running", mtimeMs: 20 },
        { id: "queued", mtimeMs: 30 },
      ]
      assert.deepStrictEqual(M.supersededSubmits(entries, "running"), ["old"])
      assert.deepStrictEqual(M.supersededSubmits(entries, "missing"), [])
      assert.deepStrictEqual(M.supersededSubmits([], "running"), [])
    })

    test("desktop hook reports the Cursor window, not the hook", () => {
      // Cursor spawns the reporter from a shared NodeService utility process,
      // then a long-lived main window process (comm "cursor"). The reporter
      // itself exits the moment it reports, so it must not be first: the
      // widget's reaper drops a badge whose first pid is dead.
      const chain = [
        { pid: 1, comm: "node", cmdline: ["/usr/bin/node", "cursor-reporter.js"], exe: "/usr/bin/node" },
        {
          pid: 2,
          comm: "electron",
          cmdline: ["/usr/lib/electron42/electron", "--type=utility", "--utility-sub-type=node.mojom.NodeService"],
          exe: "/usr/lib/electron42/electron",
        },
        {
          pid: 3,
          comm: "cursor",
          cmdline: ["/usr/lib/electron42/electron", "/usr/share/cursor/resources/app/cursor.mjs"],
          exe: "/usr/lib/electron42/electron",
        },
        { pid: 4, comm: "systemd", cmdline: ["/sbin/init"], exe: "/sbin/init" },
      ]
      const pids = M.reportablePids(chain)
      assert.deepStrictEqual(pids, [3, 4])
      assert.notStrictEqual(pids[0], 1, "the one-shot hook must not be first")
    })

    test("terminal cursor-agent reports the node process, skipping shells", () => {
      const chain = [
        { pid: 10, comm: "node", cmdline: ["/usr/bin/node"], exe: "/usr/bin/node" },
        {
          pid: 11,
          comm: "MainThread",
          cmdline: ["/home/u/.local/share/mise/installs/cursor-agent/2026.10/cursor-agent"],
          exe: "/home/u/.local/share/mise/installs/cursor-agent/2026.10/node",
        },
        { pid: 12, comm: "bash", cmdline: ["bash", "/usr/bin/cursor-agent"], exe: "/usr/bin/bash" },
        { pid: 13, comm: "ghostty", cmdline: ["ghostty"], exe: "/usr/bin/ghostty" },
      ]
      assert.deepStrictEqual(M.reportablePids(chain), [11, 12, 13])
    })

    test("no named agent falls back to the first non-shell ancestor", () => {
      const chain = [
        { pid: 20, comm: "node", cmdline: ["/usr/bin/node"], exe: "/usr/bin/node" },
        { pid: 21, comm: "sh", cmdline: ["sh", "-c", "reporter"], exe: "/usr/bin/sh" },
        { pid: 22, comm: "bash", cmdline: ["bash"], exe: "/usr/bin/bash" },
        { pid: 23, comm: "python", cmdline: ["python", "wrapper.py"], exe: "/usr/bin/python" },
      ]
      assert.deepStrictEqual(M.reportablePids(chain), [23])
    })

    test("a lone hook process reports itself", () => {
      const chain = [{ pid: 30, comm: "node", cmdline: ["/usr/bin/node"], exe: "/usr/bin/node" }]
      assert.deepStrictEqual(M.reportablePids(chain), [30])
      assert.deepStrictEqual(M.reportablePids([]), [])
    })

    test("agent and shell classification", () => {
      assert.strictEqual(M.isAgentProcess({ comm: "cursor" }), true)
      assert.strictEqual(M.isAgentProcess({ comm: "cursor-agent" }), true)
      assert.strictEqual(M.isAgentProcess({ cmdline: ["/opt/cursor-agent"] }), true)
      assert.strictEqual(M.isAgentProcess({ com: "electron", cmdline: ["/usr/lib/electron42/electron"], exe: "/usr/lib/electron42/electron" }), false)
      assert.strictEqual(M.isShellProcess({ comm: "bash" }), true)
      assert.strictEqual(M.isShellProcess({ comm: "sh" }), true)
      assert.strictEqual(M.isShellProcess({ comm: "cursor" }), false)
    })

    if (failed) {
      console.log(failed + " FAILURES")
      process.exit(1)
    }
    console.log("all cursor reporter tests pass")
  })
}

main().catch((e) => {
  console.log("FAIL harness\n     " + e.message)
  process.exit(1)
})
