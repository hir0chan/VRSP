# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

VRChat Schedule Portal — VRChat系 YouTube 配信者のライブ予定を一覧化する「ホロジュール」風サイト。GitHub Pages で静的公開し、GitHub Actions が15分毎に YouTube Data API v3 からデータを取得して再ビルド・再デプロイする。サーバ常駐・DB なし。

**現状: コードは未実装。** README.md が開発指示書であり、実装はこれから。scaffolding 時は README の §4 ディレクトリ構成に従うこと。

## 開発ワークフロー（必須）

`_doc/実装ドキュメント/開発指針&テンプレート/開発指針.md` に定められた手順に従う:

1. 実装前に実装計画書を `_doc/実装ドキュメント/実装計画書/` に作成する
   - テンプレート: `開発指針&テンプレート/実装計画書_テンプレート.md`（記入例も同ディレクトリにあり）
   - ファイル名: `yyyyMMddHHmm_<主題>.md`
2. 計画書は codex（MCP ツール `mcp__codex__codex`）のレビューを受け、指摘を修正する。判断に迷う場合のみユーザーに確認する
3. レビュー通過後、ユーザー確認を待たずに実装フェイズへ移行してよい
4. コーディングは計画書に基づき codex に依頼し、codex の生成コードを Claude がレビューする（問題があれば codex に修正させる）
5. 実装完了後、実装報告書を `_doc/実装ドキュメント/実装レポート/` に作成する。確認したい仕様があれば報告書末尾に専用セクションでまとめる
6. serena・chrome-devtools の MCP ツールを適宜活用する

## アーキテクチャ

データフロー（README §5）:

```
GitHub Actions (15分毎 cron)
  → scripts/update.ts が streamers.yaml を読み、YouTube Data API v3 を呼ぶ
  → data/generated/*.json (streams.json, streamers.json) を更新
  → Astro build（generated JSON を静的ページに焼き込む）
  → GitHub Pages へデプロイ
```

- データソースは YouTube のみ。API キーは GitHub Secrets で管理
- 取得スクリプト（`scripts/`）と表示層（`src/`）は分離。ランタイムのデータ結合はなく、ビルド時に JSON を読むだけ
- エラー処理方針: API 失敗時は既存の generated JSON を残す。1チャンネルの失敗で全体を停止しない
- データモデルは README §7 の `Streamer` / `Stream` インターフェースに従う（Status は `upcoming | live | ended`）

## 技術スタック・制約

- Astro + TypeScript (strict, `any` 禁止) + YAML
- **採用禁止**: Docker, Kubernetes, Redis, Firebase, Prisma, ORM, WebSocket, SSR, Serverless Functions, RDB。不要なライブラリを導入しない
- 実装が複数案ある場合は最も単純な案を採用する。過剰設計禁止。リファクタは最後
- UI: ダークテーマ、アクセントカラーは赤のみ、レスポンシブ対応。トップページは NOW ON LIVE → TODAY → UPCOMING の順
- コメントは「なぜ」を書く。副作用を分離し、関数は小さく
- 小さなコミット。TODO を残さない。動作確認を優先
- MVP 完成後にのみ改善提案を行う
