# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

ぶいちゃ配信アンテナ(英名: VRChat Stream Antenna。UI の日英混在は意図的な設計判断)— VRChat系 YouTube / Twitch 配信者のライブ配信・配信予定を一覧するポータル。**公開稼働中**: https://hir0chan.github.io/VRSP/ (リポジトリ: hir0chan/VRSP)

GitHub Actions が15分毎に YouTube Data API v3 / Twitch API からデータを取得し、静的ビルドして GitHub Pages へ自動デプロイする。サーバ常駐・DB なし。

当初の開発指示書(旧 README)は `_doc/実装ドキュメント/開発指示書_旧README.md` にアーカイブされている。各実装計画書が参照する「README §n」はこのアーカイブを指す。

## コマンド

- `npm run dev` — 開発サーバー(http://localhost:4321/VRSP/)
- `npm run update` — 配信データ取得(`.env` の `YOUTUBE_API_KEY` があれば実 API、なければモック)
- `npm test` — node:test を tsx --test で実行。単一ファイルは `npx tsx --test test/youtube.test.ts`
- `npm run check` — astro check + tsc --noEmit(strict、`any` 禁止)
- `npm run build` — 本番ビルド

## 開発ワークフロー(必須)

`_doc/実装ドキュメント/開発指針&テンプレート/開発指針.md` に定められた手順に従う:

1. 実装前に実装計画書を `_doc/実装ドキュメント/実装計画書/` に作成(テンプレート・記入例が同ディレクトリの `開発指針&テンプレート/` にある。ファイル名 `yyyyMMddHHmm_<主題>.md`)
2. 計画書は codex(MCP ツール `mcp__codex__codex`)のレビューを受け、指摘を修正。レビュークリア後はユーザー確認を待たず実装へ
3. コーディングは計画書に基づき codex に依頼し、生成コードを Claude がレビュー(問題があれば codex に修正させる)
4. 実装完了後、実装報告書を `_doc/実装ドキュメント/実装レポート/` に作成。ユーザーに確認したい事項は報告書末尾に専用セクションを設ける。計画書には「実施結果」を追記し状態を更新する
5. serena・chrome-devtools の MCP ツールを適宜活用する
6. ユーザーとのやりとりの記録は `_doc/cclog.md`(ユーザーが記入)

小さなデザイン調整・文言変更などの軽微な作業は計画書なしの直接対応で進めてきた実績がある(検証とコミットは必ず行う)。

## アーキテクチャ

```
GitHub Actions (15分毎 cron / workflow_dispatch)
  → scripts/update.ts が YouTube の候補動画・既知動画と Twitch の VRChat カテゴリのライブを更新
  → data/generated/{discovery,streams,streamers}.json を更新(差分があれば bot がコミット [skip ci])
  → Astro build(generated JSON をビルド時 import)
  → GitHub Pages へデプロイ(push 時は update をスキップしコミット済みデータでビルドのみ)
```

- **データ取得**(`scripts/youtube.ts`): `search.list(part=id)` の live / upcoming / completed 3クエリで候補を発見し、追跡集合を `videos.list`(50件バッチ)で毎回更新する。タイトルまたは説明文に `vrchat` を含む動画のみ採用。部分バッチ失敗は動画単位で前回値を引き継ぎ、全滅時は本体を書き込まず非0終了
- **Twitch データ取得**(`scripts/twitch.ts`): 実行毎に App Access Token を取得し、VRChat カテゴリの通常最大3ページと日本語1ページを取得する。成人向けを除外し、日本語全件と非日本語の視聴者数上位50件を表示用 `streams` のみに追加する。Twitch 失敗時はその回の Twitch 分を省略する
- **発見状態**: `data/generated/discovery.json` に試行時刻を原子的に保存し、60分クールダウンを CI 間で維持する。`--discover` はローカル手動実行専用
- **追跡と表示**: `streams.json` の `tracked` は表示窓外も含む追跡集合、`streams` は UI 用表示窓。非 live の追跡上限は300件。チャンネル情報は動画 snippet から動的生成し、除外は `data/blocklist.yaml` で管理する
- **モード切替**: `YOUTUBE_API_KEY` 未設定なら YouTube / Twitch の内蔵架空データを自動生成(`scripts/mock.ts`、純関数)。実データモードで Twitch 認証情報が未設定なら YouTube のみ取得する。CI では Secrets から注入(`update.yml` の env — **YOUTUBE_API_KEY を外すと本番がモックデータになる**)
- **表示層**(`src/`): 分類ロジック(live/today/upcoming、JST 日付グループ化)は `src/lib/classify.ts` の純関数に分離。サムネ URL 解決は `src/lib/thumbnail.ts`(絶対 URL はそのまま、相対パスに BASE_URL 前置)
- **データモデル**: `scripts/models.ts` の `Streamer` / `Stream`(status: upcoming | live | ended、platform 欠落は YouTube)。Twitch は live のみで追跡集合には入れない。YouTube の ended は取得後24時間保持・画面非表示
- **書込**: 一時ファイル → rename のファイル単位原子的書込。`streamers.json` を先に、`streams.json` を後に rename し、配信者情報は前回参照分を2世代保持する。blocklist の設定エラーは非0終了で既存データを保護する

## 制約・慣習

- **採用禁止**: Docker, Kubernetes, Redis, Firebase, Prisma, ORM, WebSocket, SSR, Serverless Functions, RDB。依存追加は最小限(現在 devDependencies 6個のみ)
- 実装が複数案ある場合は最も単純な案を採用。過剰設計禁止
- strict TypeScript・`any` 禁止・副作用分離・コメントは「なぜ」のみ・小さなコミット
- UI: 日本語・ライトテーマ(明るく軽く。ダークテーマは不採用)・アクセントは赤系のみ(コントラスト規則: 白抜き文字の地色と小さい赤文字は `--accent-deep`、`--accent` は大テキスト・装飾専用)・レスポンシブ・Zen Maru Gothic
- コミット名義はリポジトリローカル設定の hir0chan(noreply メール)。**グローバル git 設定(別名義)を使わないこと。旧名義や個人情報をコミット・コード・ドキュメントに含めない**
- push すると本番デプロイが走る。cron の bot コミットと競合したら `git pull --rebase`
- `.env` は gitignore 済み。API キーをログ・コード・ドキュメントに出さない
