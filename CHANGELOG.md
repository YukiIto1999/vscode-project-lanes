# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.6] - 2026-05-14

### Changed

- Reverted all user-facing UI strings to English. The 0.1.4 release had switched tree descriptions, decoration tooltips, status bar text / tooltip, and the activity badge tooltip to Japanese; this release restores English as the canonical UI language. Internal source comments and `*.ja.md` remain in Japanese
- Translated the remaining user-facing strings that were Japanese-only to English: the missing-`.lanes-root` warning in `extension.ts`, the unsaved-files warning, the Rename Lane input box and its validation messages, the lane-removal confirmation dialog, the active-lane-removal warning, and the `viewsWelcome` placeholders for the Lanes panel
- Translated all prior CHANGELOG entries (0.0.2 through 0.1.5) to English to match the policy

## [0.1.5] - 2026-05-12

### Added

- Title-bar icon actions on the Lanes panel: Add Folder (`$(add)`) launches `workbench.action.addRootFolder` and feeds the existing `reconcileUserChange → absorb` path; Reload Lanes (`$(refresh)`) rebuilds `registry` by re-reading `workspaceFolders`, symlink targets, and `catalogStore`
- Right-click menu (`view/item/context`) on lane items: Rename Lane and Remove Lane. Rename rewrites the `label` (which doubles as `lane.id`) and re-keys `terminal/service`'s `state.sessions[*].spec.laneId`, the `state.lanes` Map keys, the `LaneSessionStore` keys, and `selectionStore`'s `activeLaneId` before updating the catalog, so terminal sessions survive the rename
- Removal only excludes the lane from the catalog; the folder on disk is not touched. Removing the active lane is rejected before the modal with a prompt to switch to another lane first
- Pure planning functions `planLaneRename` / `planLaneRemoval` in `src/lane/`. Validation (duplicate / empty) and active-lane-removal rejection are expressed via ADTs
- `architecture.test.ts` now asserts string-level consistency between `tree-view.ts`'s `contextValue = 'projectLane'` and the `when` clauses under `menus.view/item/context` in `package.json`

### Changed

- Shortened existing command `title` and split out `category: "Project Lanes"`. The Command Palette still shows the `Project Lanes: ...` prefix, while context menus now show the short name without the prefix
- The `viewsWelcome` "Add folder to workspace" link now goes through the new `projectLanes.addFolder` command

## [0.1.4] - 2026-05-06

### Changed

- Raised `engines.vscode` from `^1.96.0` to `^1.101.0` to require the Node 22 runtime (Electron 35+). `@types/vscode` is bumped to match, aligning with `tsconfig.json`'s `lib: ES2024` and build target `node22`
- Added `.git/**`, `.github/**`, and `*.vsix` to `.vscodeignore` to minimize the VSIX payload

### Removed

- Unused brand types `LanesSessionId` / `ProcessId` / `UnixSeconds` / `ActiveLinkState`

## [0.1.3] - 2026-04-30

### Changed

- Activity observation is now keyed by PTY session (`SessionId`) instead of VS Code Terminal (`TerminalId`), so its lifecycle is independent of Pseudoterminal attach / detach. Inactive lanes now have `working` / `waiting` / `no-agent` evaluated in real time. Observation is driven by an in-process OSC 633 parser (discriminated-union state machine) attached to `node-pty`'s `proc.onData`
- Consolidated `lane-activity`'s input ports from four subscription types into a single fact-ingress port (`SessionActivitySink`). The service gates on projection diffs and only fires `onChange` when the displayed value changes
- Changed `LaneResolverPort` to a session-scoped `resolveLaneBySession`. bootstrap injects the `terminalService` implementation
- Observation timestamps are sealed in `Instant = Brand<number, 'Instant'>` and obtained exclusively via `MonotonicClockPort`

### Removed

- `src/adapters/vscode/terminal-execution-events.ts` / `terminal-output-events.ts` / `terminal-input-events.ts`. Dropped the dependency on VS Code's official Shell Integration (`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`)
- `createLifecycleEventBus` inside bootstrap. Session termination flows from `proc.onExit` straight into the sink

### Added

- `src/adapters/pty/osc633.ts` (pure state machine). Extracts OSC 633 `;C` / `;D` and emits non-OSC segments as `output` in chronological order
- `src/architecture.test.ts`. Machine-verifies that `lane-activity` does not depend on `vscode` / `node-pty` / `adapters`, does not use `TerminalId`, does not call `Date.now` directly, and never re-introduces the old Shell Integration APIs

## [0.1.2] - 2026-04-29

### Changed

- Redesigned lane activity detection as a three-state classification (`agent-working` / `agent-waiting` / `no-agent`). OSC 633 gates foreground execution, and PTY-output stagnation (1.5s) separates working from waiting. Echoes from keystrokes (shell / TUI self-redraw) are filtered by an input-vs-output gap (`ECHO_GAP_MS=100ms`) evaluated in `lane-activity`'s projection rules (business rules are kept out of the adapter layer). Dropped procfs / Claude session JSONL / child-process-tree monitoring. OSC 633 integration scripts are injected at `bash` / `zsh` startup via `--rcfile` / `ZDOTDIR`
- Reorganized configuration keys: removed `projectLanes.refreshInterval` and `projectLanes.agent.idleThreshold`; renamed `projectLanes.agent.showStatus` to `projectLanes.activity.showIndicator`
- Removed the concept of kind detection (claude-code / codex-cli / gemini-cli / copilot-cli). Detection is a generic "foreground + output stagnation" heuristic
- Refreshed UI representation for three states. `working` uses `$(sync~spin)` + green dot; `waiting` uses `$(bell)` + yellow dot; `no-agent` shows nothing. The Activity Bar badge counts only `waiting` lanes

### Removed

- The entire `src/agent/` directory (model / ports / service / activity-policy / summarizer / resolver / sources)
- `src/adapters/linux/procfs.ts` and `claude-sessions.ts`
- The periodic-execution adapter `src/adapters/vscode/timers.ts`

## [0.1.1] - 2026-04-27

### Fixed

- Default terminal profile could not be matched by `id`. VS Code matches `terminal.integrated.defaultProfile.<platform>` against the contributed profile's `title`, so writing the id caused the built-in bash to open with `.lanes-root/active` as the cwd instead of going through the projectLanes path
- When the terminal "+" button created a terminal, `provideTerminalProfile` returned `undefined`, leaving the unmanaged terminal open in `.lanes-root/active`. It now returns a proper `vscode.TerminalProfile`, unifying the creation path into the single lane-aware route
- Managed terminals inherited the parent environment's `PWD`, so prompts showed the path via the symlink. The real lane path is now explicitly injected as `PWD`

### Changed

- On lane switch, immediately after swapping the symlink target, `workspaceFolders[0].name` is updated to the destination lane's label (the URI is unchanged, so no extension-host restart). A new `LaneViewRebindPort` simultaneously addresses both the Explorer root-display lag and the tree redraw via a folder-change event. The Git extension's cached Repository is discarded with `git.close` and re-scanned via `git.openRepository`, so the SCM view also follows. Avoids forcing the Explorer view to focus by no longer running `refreshFilesExplorer` directly
- Added `readLaneTerminalProfile` to read the lane terminal profile id / title from the `package.json` contribution as a single source. Removed the duplicated strings in bootstrap
- Reorganized `terminal/service`'s API: removed `addTerminal`; exposed `requestSession` + `bindTerminal` for the profile path
- Modeled terminal unbinding as `TerminalCommand.terminalUnbound`, removing the `undefined as unknown as TerminalId` type cast
- Removed dead code in `TerminalEffect` (`spawnSession`, `attachTerminal`, `showTerminal`)

## [0.1.0] - 2026-04-26

### Changed

- Overhauled workspace design. Replaced the scheme of listing a `.lanes-root` anchor folder alongside the other entries in `workspaceFolders` with a single-`workspaceFolder` scheme backed by the `.lanes-root/active` symlink. Lane switches are now completed by swapping the symlink alone, without modifying `workspaceFolders`
- The `.code-workspace` file is treated as the canonical lane catalog. Structure detection at startup migrates older layouts to the new final state automatically
- The agent detection filter is now always applied (previously, other processes leaked through when no managed terminal was running)
- Agent active/idle hysteresis is keyed by `LANES_SESSION_ID` to eliminate false detections from PID reuse

### Fixed

- No longer prompts whether to open new terminals in `.lanes-root` or in the project (the single-`workspaceFolder` design makes the prompt unnecessary)
- Eliminated the `.lanes-root` section at the top of the Explorer
- Eliminated the folder-selection prompt when creating a new file / folder in the Explorer

### Removed

- Removed the `Project Lanes: Unfocus` command, which is meaningless in the single-`workspaceFolder` design
- Cleaned up dead internal contracts tied to the old anchor design (`LaneVisibilityPort`, `ProjectLanesRuntime`, `folder-plan`, `TerminalCommand.pendingQueued`, etc.)

## [0.0.2] - 2026-04-13

### Fixed

- Fixed a fatal startup failure caused by `node-pty` not being bundled
- Fixed a mismatch between the default value of `idleThreshold` and its declaration in `package.json`
- Fixed the missing user notification when workspace initialization failed
- Fixed the fallback for the case where the `HOME` environment variable is an empty string

## [0.0.1] - 2026-04-12

### Added

- Lane switching across Explorer, editor tabs, terminals, and Git
- Claude Code agent monitoring with idle/active status
