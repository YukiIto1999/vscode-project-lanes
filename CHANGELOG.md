# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-26

### Changed

- ワークスペース設計を全面見直し。`.lanes-root` アンカーフォルダを `workspaceFolders` に並べる方式を廃止し、`.lanes-root/active` symlink を単一 workspaceFolder とする方式へ変更。レーン切替は symlink 差替のみで完結し、`workspaceFolders` 変更を伴わない
- `.code-workspace` をレーンカタログの正本として扱い、起動時の構造検出で旧構造からも同じ最終状態へ自動移行
- エージェント検出フィルタを常時適用（従来は管理ターミナル未起動時に他プロセスが表出していた挙動を解消）
- エージェントの active/idle ヒステリシスを `LANES_SESSION_ID` 軸で管理し PID 再利用による誤判定を解消

### Fixed

- ターミナル作成時に `.lanes-root` とプロジェクトのどちらに開くかを尋ねられる問題を解消（単一 workspaceFolder 化により発生しなくなった）
- Explorer トップに `.lanes-root` セクションが表示される問題を解消
- Explorer 新規ファイル/フォルダでフォルダ選択を要求される問題を解消

### Removed

- `Project Lanes: Unfocus` コマンドを削除。単一 workspaceFolder 設計では意味を持たないため
- 旧アンカー関連の内部契約（`LaneVisibilityPort`, `ProjectLanesRuntime`, `folder-plan`, `TerminalCommand.pendingQueued` 等の死に契約）を整理

## [0.0.2] - 2026-04-13

### Fixed

- node-pty 未同梱により拡張機能が起動しない致命的不具合を修正
- idleThreshold のデフォルト値が package.json 宣言と不一致だった問題を修正
- ワークスペース初期化失敗時にユーザーへの通知がなかった問題を修正
- HOME 環境変数が空文字列の場合にフォールバックが効かない問題を修正

## [0.0.1] - 2026-04-12

### Added

- Lane switching across Explorer, editor tabs, terminals, and Git
- Claude Code agent monitoring with idle/active status
