# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
