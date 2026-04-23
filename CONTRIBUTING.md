# Contributing

## ブランチ

| 名前 | 役割 |
|---|---|
| `main` | 公開用。push で Marketplace 公開と GitHub Release 作成が自動発火 |
| `develop` | 次リリースの統合先 |
| `feat/*` | 機能追加・構造改修 |
| `fix/*` | 非緊急の修正 |
| `refactor/*` | 内部整理 |
| `hotfix/*` | 公開済みリリースに対する緊急修正。`main` から分岐し `main` と `develop` の両方へ反映する |

直接 push は `main` と `develop` のいずれも禁止。作業ブランチから PR を経て merge する。

## PR

| 経路 | merge 方式 | 必須条件 |
|---|---|---|
| `feat/* → develop` | squash | CI green |
| `develop → main` | merge commit | CI green、`package.json` と `CHANGELOG` の版が一致、`[Unreleased]` が実日付に置換済み |
| `hotfix/* → main` | squash | CI green |

## コミットメッセージ

件名のみで変更意図を示し、詳細本文・箇条書きは書かない。詳細は PR 本文と `CHANGELOG` に集約する。

## リリース手順

1. `develop` で対象機能が揃い、CI が green
2. `CHANGELOG.md` の `[x.y.z] - Unreleased` を `[x.y.z] - YYYY-MM-DD` に差し替え
3. `package.json` の `version` が `x.y.z` であることを確認
4. `develop → main` の PR を「Release x.y.z」として出す
5. merge すると `.github/workflows/release.yml` が発火し、Marketplace へ publish・git tag `v<x.y.z>`・GitHub Release を生成
6. 次リリース準備として `develop` の `CHANGELOG` 先頭に新しい `[Unreleased]` セクションを追加し、`package.json` を次版へ bump

## 自動検証

PR・develop への push で `.github/workflows/ci.yml` が以下を実行する:

- `npm run check`（format + lint）
- `npm test`
- `npm run build`

いずれかが失敗すれば merge はブロックされる。

## 秘匿情報

Marketplace publish には `yukiito1999` publisher の PAT が必要。GitHub Actions secrets に `VSCE_PAT` として登録する。ローカルの `git remote -v` や `.git/config` に PAT を埋め込まないこと。
