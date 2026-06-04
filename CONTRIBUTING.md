# CONTRIBUTING

## ブランチ

統合ブランチは `develop`、リリースブランチは `main`。変更は `develop` から枝を切り、作業後に `develop` へ戻す。`main` への直接コミットはしない。

ブランチ名は用途を表す prefix を完全形で付ける（`feat/` ではなく `feature/`）。

| prefix      | 用途                         |
| ----------- | ---------------------------- |
| `feature/`  | 機能追加                     |
| `fix/`      | バグ修正                     |
| `refactor/` | 挙動を変えない構造改善       |
| `chore/`    | 雑務・依存更新・リリース準備 |
| `ci/`       | CI 設定                      |
| `docs/`     | ドキュメント                 |

## コミット

`型: 要約` の一行で書き、型はブランチの prefix に揃える。要約は変更内容が読み取れる日本語にし、本文は付けない。一つのコミットには一つの関心のみを含め、無関係な変更は分ける。`Co-authored-by` などの自動生成痕跡は残さない（`commit-msg` フックが拒否する）。

## マージ

`develop` へは `--no-ff` でマージし、`Merge branch '<branch>' into develop` のマージコミットを残す。個々のコミットを保ったまま、一連の作業が履歴上で一塊として見える。`feature/` はリリースに対応する記録として残し、それ以外の作業ブランチはマージ後に削除する。`develop` への push で `ci.yml` が check・test・build を実行する。

## リリース

1. `develop` で `package.json` の `version` を更新（セマンティックバージョニング）
2. `CHANGELOG.md` に該当バージョンの節を追記
3. `chore: release X.Y.Z` でコミットし `develop` へマージ
4. `main` を該当コミットへ進めて push

`main` への push を受けて `release.yml` が check・test・build を通し、Marketplace への publish、`vX.Y.Z` タグ、`CHANGELOG.md` の該当節を本文としたリリース作成までを自動で行う。
