[English](README.md) | [日本語](README.ja.md)

# Project Lanes

Project Lanes is a VS Code extension for working across multiple projects without showing every project at once. Each project becomes a lane, and switching lanes changes Explorer, Git, editor tabs, and terminals as one context.

[Install Project Lanes - Fast Switching from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yukiito1999.project-lanes).

## Why Project Lanes

A standard multi-root workspace shows every project in Explorer and mixes their tabs and terminals. That becomes difficult to navigate when several coding agents or long-running processes are active across different projects.

Project Lanes keeps those projects in one workspace but shows only the active lane. Terminals for other lanes keep running in the background, and the activity indicator shows which lane is working or waiting.

## Requirements

- VS Code 1.101 or later
- Linux or macOS with a filesystem that supports symbolic links
- A saved `.code-workspace` file containing at least one project folder

Windows is not currently tested. An unsaved workspace must be saved before Project Lanes can initialize it.

## Getting started

### Create a new workspace

1. In VS Code, use **Add Folder to Workspace...** to add each project you want to manage.
2. Use **Save Workspace As...** to save the workspace as a `.code-workspace` file.
3. Open the **Lanes** view and select **Initialize Workspace**, or run `Project Lanes: Initialize Workspace` from the Command Palette.
4. Select a lane from the **Lanes** view to switch projects.

VS Code may reload the window after saving the workspace and again during initialization. This is expected when the workspace identity or first workspace folder changes. This setup is required only once for each `.code-workspace` file.

### Use an existing workspace file

Open a saved `.code-workspace` file that contains the project folders you want to manage, then run `Project Lanes: Initialize Workspace`. Project Lanes imports the existing folders as lanes.

### Initialize automatically

The default `projectLanes.initializationMode` is `manual`, so Project Lanes does not change an unmanaged workspace until you explicitly initialize it. Set the option to `automatic` to initialize a saved workspace when the extension starts. Unsaved workspaces still need to be saved first.

## What initialization changes

Initialization:

- records the current workspace folders as lanes in VS Code workspace state;
- creates `.lanes-root/<workspace-hash>/active` next to the `.code-workspace` file;
- replaces the visible workspace folders with that single active-lane link; and
- temporarily selects Lane Terminal as the workspace default terminal profile, so the standard terminal **+** button opens a shell in the active lane's real directory.

Project Lanes does not move, rename, edit, or delete project directories. Renaming a lane changes only its display metadata. Removing an inactive lane leaves its directory untouched, but closes that lane's terminals and discards its saved editor-tab state. If the workspace file is stored inside a Git repository, add `.lanes-root/` to that repository's `.gitignore` when you do not want the generated directory tracked.

## Everyday use

### Switch lanes

Select a lane in the **Lanes** view or run `Project Lanes: Switch Lane`. Explorer and Git follow the selected project. File tabs are saved for the previous lane and restored for the selected lane.

If any editor has unsaved changes, save them before switching. Project Lanes cancels the switch to avoid losing those changes.

### Add another project

Use the **+** button in the **Lanes** view and select a folder. You can also use VS Code's standard **Add Folder to Workspace...** command. In a managed workspace, Project Lanes imports the added folder as a lane and returns Explorer to the single active-lane view. You do not need to save or initialize the workspace again.

### Manage lanes

Right-click a lane to rename it or remove it from the workspace. Removing a lane leaves its directory on disk untouched. The active lane cannot be removed. If a lane directory was moved or is no longer accessible, use `Project Lanes: Locate Folder` to associate it with a readable directory.

### Search across lanes

`Project Lanes: Find in Lanes` searches file contents across every available lane with ripgrep. `Project Lanes: Go to File in Lanes` finds files by name across available lanes. Choosing a result switches to its lane before opening the file.

## What follows a lane switch

| Area             | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Explorer and Git | Show only the active lane                                                                                                     |
| Editor tabs      | Save and restore normal file tabs per lane, including across VS Code restarts                                                 |
| Terminals        | Open Lane Terminal from the standard **+** in the active lane's real directory and keep its processes running across switches |
| Activity         | When activity indicators are enabled, show `working` or `waiting`; no indicator means `no-agent`                              |

Activity detection uses a generic heuristic based on OSC 633 shell integration and real-time terminal output. It works with `bash` and `zsh` and does not depend on a specific coding agent.

## How lane switching works

The workspace exposes one stable folder URI at `.lanes-root/<workspace-hash>/active`. Switching lanes changes only that symbolic link's target, so the extension host does not need to restart and background terminal processes can continue running.

The full 64-character SHA-256 workspace hash gives each `.code-workspace` file in the same directory its own active link. The lane catalog remains in VS Code workspace state rather than in the `.code-workspace` file.

## Commands

| Command                                    | Description                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `Project Lanes: Initialize Workspace`      | Import the folders in a saved workspace and start managing it           |
| `Project Lanes: Switch Lane`               | Switch to a lane                                                        |
| `Project Lanes: Add Folder to Workspace`   | Add a folder as a lane, starting the picker at the active lane's parent |
| `Project Lanes: Reload Lanes`              | Reconcile workspace folders, the active link, and the saved selection   |
| `Project Lanes: Locate Folder`             | Associate a missing or inaccessible lane with a readable folder         |
| `Project Lanes: Rename Lane`               | Change a lane's display name without changing its identity or sessions  |
| `Project Lanes: Remove Lane`               | Remove an inactive lane from the catalog without deleting its directory |
| `Project Lanes: Close Terminals`           | End all terminal sessions for the active lane                           |
| `Project Lanes: Toggle Activity Indicator` | Show or hide activity indicators without restarting VS Code             |
| `Project Lanes: Find in Lanes`             | Search file contents across available lanes and open a match            |
| `Project Lanes: Go to File in Lanes`       | Find a file across available lanes and open it                          |

## Settings

| Setting                               | Default  | Description                                                              |
| ------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `projectLanes.initializationMode`     | `manual` | Choose explicit or startup initialization for unmanaged saved workspaces |
| `projectLanes.activity.showIndicator` | `true`   | Show lane activity in the badge, decoration, and status bar              |
| `projectLanes.terminal.shellPath`     | `""`     | Shell used by Lane Terminal; an empty value uses `$SHELL`                |

## Upgrading from v0.1.13

Project Lanes reads the former `.lanes-root/active` link only when the current workspace folder and saved catalog both confirm that it belongs to the workspace. The former link is migration input only and is never changed or removed.

Earlier versions may also have left terminal workspace settings behind. When current values match those settings, Project Lanes asks how to handle them:

- `Manage Lane Terminal` adopts the matching default profile into the current reversible lease.
- `Keep Current Settings` preserves the matching values before Project Lanes acquires the current reversible lease.
- `Remove Legacy Settings` removes the matching values before Project Lanes acquires the current reversible lease.

Every choice keeps the standard terminal **+** button connected to Lane Terminal while Project Lanes manages the workspace. When the extension stops, it restores the previous default profile if no other process or user changed that setting.

## Limitations

- Symbolic-link-based switching is designed for Linux and macOS; Windows is untested.
- Activity detection requires `bash` or `zsh` and OSC 633. Other shells such as `fish` and `pwsh` fall back to `no-agent`.
- Editor restoration covers normal file tabs, not diff views or notebooks.
- Terminal sessions do not survive a VS Code window reload.

## License

MIT
