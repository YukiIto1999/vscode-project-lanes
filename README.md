[English](README.md) | [日本語](README.ja.md)

A VS Code extension that manages projects as "lanes" within a workspace and switches the full context at once.
Built for developers running AI coding agents across multiple projects.

## The Problem

When running many projects:

- Explorer shows all projects flat, hard to navigate
- Terminals pile up across projects
- Editor tabs from different projects get mixed
- No way to tell which project's agent is idle when running agents in parallel

## Features

Each project becomes a "lane". Switching lanes swaps Explorer, editor tabs, terminals, and Git together.
The switch is a view change — background terminals keep running because the workspace folder URI stays stable (a `.lanes-root/active` symlink whose target is updated on switch).

- Lane switching
  - Explorer and Git show only the active lane
  - Editor tabs are saved and restored per lane
  - Terminals persist in the background across switches
- Activity indicator
  - Shows `working` / `waiting` / `no-agent` per lane, including lanes that aren't currently active
  - Detection is a generic heuristic over OSC 633 shell integration (bash / zsh) and real-time PTY output observation; not specific to any agent

## Commands

| Command                          | Description                                    |
| -------------------------------- | ---------------------------------------------- |
| `Project Lanes: Focus`           | Switch to a lane                               |
| `Project Lanes: Close Terminals` | Kill all terminal sessions for the active lane |

## Settings

| Setting                               | Default | Description                                                  |
| ------------------------------------- | ------- | ------------------------------------------------------------ |
| `projectLanes.activity.showIndicator` | `true`  | Show activity indicator in badge, decoration, and status bar |
| `projectLanes.terminal.shellPath`     | `""`    | Shell path for Lane Terminal (empty = `$SHELL`)              |

## Limitations

- The symlink-based lane switching assumes a POSIX filesystem (Linux / macOS); Windows is untested
- Activity detection requires shell integration via `bash` or `zsh` and OSC 633. Other shells (`fish`, `pwsh`, etc.) skip injection and fall back to `no-agent`
- Tab restore covers normal file tabs only (not diff views, notebooks, etc.)
- Terminal sessions don't survive VS Code window reloads
- The extension creates `.lanes-root/` next to the `.code-workspace` file; add it to `.gitignore` if you don't want it tracked

## License

MIT
