# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-04-29

### Changed

- レーン活動検出を 3 値判別 (`agent-working` / `agent-waiting` / `no-agent`) に再設計。OSC 633 で foreground 実行有無を切り、PTY 出力時刻の停滞 (1.5s) で working / waiting を分離する。打鍵に対するエコー (シェル / TUI 由来の自前再描画) は、入力時刻と出力時刻のギャップ (`ECHO_GAP_MS=100ms`) を `lane-activity` の射影規則で評価して除外する (adapter 層には業務規則を持たせない)。procfs / Claude セッション JSONL / 子プロセスツリー監視は廃止。`bash` / `zsh` 起動時に OSC 633 統合スクリプトを `--rcfile` / `ZDOTDIR` 経由で注入
- 設定キーを再編。`projectLanes.refreshInterval` と `projectLanes.agent.idleThreshold` を削除、`projectLanes.agent.showStatus` を `projectLanes.activity.showIndicator` にリネーム
- 種別判定 (claude-code / codex-cli / gemini-cli / copilot-cli) の概念を撤去。検出は汎用的な「foreground + 出力途絶」ヒューリスティック
- UI 表記を 3 値対応へ刷新。working は `$(sync~spin)` + 緑●、waiting は `$(bell)` + 黄●、no-agent は無表示。Activity Bar バッジは waiting レーン数のみカウント

### Removed

- `src/agent/` 一式 (model / ports / service / activity-policy / summarizer / resolver / sources)
- `src/adapters/linux/procfs.ts` および `claude-sessions.ts`
- 周期実行アダプター `src/adapters/vscode/timers.ts`

## [0.1.1] - 2026-04-27

### Fixed

- 既定ターミナルプロファイルが `id` で照合不能だった問題を修正。VS Code は `terminal.integrated.defaultProfile.<platform>` を contributed profile の `title` で照合するため、id を書き込んでいた従来コードでは projectLanes 経路に乗らず内蔵 bash が `.lanes-root/active` を cwd に開いていた
- ターミナル「+」生成時に `provideTerminalProfile` が `undefined` を返して未管理ターミナルが `.lanes-root/active` で開かれていた問題を修正。正規の `vscode.TerminalProfile` を返却し、生成経路をレーン単一に統一
- 管理ターミナルで親環境の `PWD` を継承し、プロンプトが symlink 経由のパスを表示していた問題を修正。レーン実パスを `PWD` として明示注入

### Changed

- レーン切替時、symlink target 入替直後に `workspaceFolders[0].name` を切替先レーン label へ更新（同 URI なので拡張ホスト再起動なし）。Explorer ルート表示の追従漏れと、フォルダ変更イベント経由のツリー再描画を同時に実現する `LaneViewRebindPort` を新設。Git 拡張のキャッシュ済 Repository を `git.close` で破棄してから `git.openRepository` で再 scan させる 2 段階で SCM 表示も切替先レーンへ追従。`refreshFilesExplorer` 直接実行による Explorer ビュー強制 focus を回避
- Lane Terminal プロファイルの id / title を `package.json` の contributes 宣言から単一読出する `readLaneTerminalProfile` を新設。bootstrap 内の重複文字列を排除
- `terminal/service` の API を再構成: `addTerminal` を撤去し、`requestSession` + `bindTerminal` をプロファイル経路向けに公開
- ターミナル束縛解除を `TerminalCommand.terminalUnbound` として型表現し、`undefined as unknown as TerminalId` の型キャストを排除
- 死コードとなっていた `TerminalEffect` の `spawnSession` / `attachTerminal` / `showTerminal` を削除

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
