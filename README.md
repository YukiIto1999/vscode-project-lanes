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
- Agent monitoring
  - Detects Claude Code processes and shows idle/active per lane

## Commands

| Command                          | Description                                    |
| -------------------------------- | ---------------------------------------------- |
| `Project Lanes: Focus`           | Switch to a lane                               |
| `Project Lanes: Close Terminals` | Kill all terminal sessions for the active lane |

## Settings

| Setting                            | Default | Description                                            |
| ---------------------------------- | ------- | ------------------------------------------------------ |
| `projectLanes.refreshInterval`     | `1`     | Agent status polling interval (seconds)                |
| `projectLanes.agent.idleThreshold` | `5`     | Seconds of inactivity before marking an agent as idle  |
| `projectLanes.agent.showStatus`    | `true`  | Show agent status in badge, decoration, and status bar |
| `projectLanes.terminal.shellPath`  | `""`    | Shell path for Lane Terminal (empty = `$SHELL`)        |

## Limitations

- Agent monitoring is Linux only (`/proc`); the symlink-based workspace layout is also Linux-specific
- Tab restore covers normal file tabs only (not diff views, notebooks, etc.)
- Terminal sessions don't survive VS Code window reloads
- The extension creates `.lanes-root/` next to the `.code-workspace` file; add it to `.gitignore` if you don't want it tracked

## License

MIT
