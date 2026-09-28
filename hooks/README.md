# opencode-spaces

Agent-status reporter for [opencode](https://opencode.ai), feeding the
[Omarchy Spaces](https://github.com/tornikegomareli/omarchy-spaces) bar widget.
A terminal running opencode gets the same badge a Claude Code terminal gets:
a spinner while the agent works, a pulsing `!` when it needs your input, and
a check mark when it is done.

## Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@farzadhayat/opencode-spaces"]
}
```

Restart opencode, run a prompt, and the terminal icon spins in the bar while
it works.

## Behavior

- `working` and `done` are reported as opencode works.
- `waiting` needs a permission prompt, so with `--auto` it rarely appears:
  opencode answers its own permission requests in milliseconds, and the
  reporter waits 1.5s before showing `!` so an instantly answered prompt
  never flashes. Run `opencode` without `--auto` to see it.

Full docs live in the
[Spaces repository](https://github.com/tornikegomareli/omarchy-spaces).
