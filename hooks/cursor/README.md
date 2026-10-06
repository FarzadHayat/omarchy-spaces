# cursor-spaces

Agent-status reporter for [Cursor](https://cursor.com), feeding the
[Omarchy Spaces](https://github.com/tornikegomareli/omarchy-spaces) bar widget.

A Cursor window (or a terminal running `cursor-agent`) gets the same badge a
Claude Code terminal gets:

- spinner while the agent works
- check mark when the turn finishes
- badge clears when the conversation closes

## Install

The reporter ships with the Omarchy Spaces plugin, so it is already on disk at

```
~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js
```

Register it in `~/.cursor/hooks.json` (covers both the desktop app and
`cursor-agent`):

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "sessionStart": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "preToolUse": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "beforeShellExecution": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "afterShellExecution": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "afterFileEdit": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "postToolUse": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "afterAgentThought": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }],
    "stop": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10, "loop_limit": null }],
    "sessionEnd": [{ "command": "~/.config/omarchy/plugins/tornikegomareli.spaces/hooks/cursor/cursor-reporter.js", "timeout": 10 }]
  }
}
```

The path lives inside the installed plugin, so `omarchy plugin update
tornikegomareli.spaces` keeps the reporter current; there is no npm package.

The `stop` entry needs `"loop_limit": null`: Cursor disables `stop` hooks after
5 runs by default, which would silently kill the reporter mid-session.

Run an agent prompt and the Cursor window spins in the bar while it works.

## Notes

- `waiting` is not reported: Cursor exposes no hook for "the agent asked the
  user a question", so a `!` badge would be a guess.
- `cursor-agent` in a terminal fires only a subset of hooks
  (`sessionStart`, shell hooks, `postToolUse`, `stop`), so its badge follows
  the same transitions with coarser steps.
- `stop` with an aborted or errored turn still reports `done`: it deserves a
  look, and the next prompt flips back to `working`.

## Uninstall

Remove the entries from `~/.cursor/hooks.json`.
