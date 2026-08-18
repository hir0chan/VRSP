# ぶいちゃ配信アンテナ

VRChat系配信者のライブ配信と今後の配信予定を、ひとつの場所にまとめたスケジュールポータルです。

**🌐 https://vcha-antenna.com/** (English: https://vcha-antenna.com/en/)

![ぶいちゃ配信アンテナ](public/images/ogp.png)

## 特徴

- **NOW ON LIVE** — 配信中のライブを最優先で大きく表示
- **本日の配信 / 今後の配信** — 配信予定を JST の日付ごとに整理
- **3プラットフォーム対応** — YouTube / Twitch / ニコニコ生放送の VRChat 系配信をまとめて掲載
- **絞り込み** — プラットフォーム・日本語のみ・自由入力検索。`?q=◯◯` 付き URL で検索済み状態を共有可能
- **15分毎の自動更新** — GitHub Actions が各プラットフォームから取得し、自動で再ビルド・再デプロイ
- **X 自動ポスト** — 2時間毎に配信中の日本語配信から1件を [@hir0chan_vrc](https://x.com/hir0chan_vrc) で自動紹介
- **完全静的・メンテナンスフリー** — サーバ常駐なし、データベースなし。GitHub Pages のみで稼働

## 仕組み

```text
GitHub Actions (15分毎 cron)
      │
      ▼
YouTube Data API v3 ──┐
Twitch API ───────────┼── scripts/update.ts が取得
ニコニコ生放送 検索 ──┘   (YouTube は約1時間毎に発見検索、追跡分と Twitch/ニコ生ライブは毎回更新)
      │
      ├── scripts/digest.ts ── 前回から2時間経過していれば
      │       │                 配信中から1件選び IFTTT Webhook 経由で X にポスト
      │       ▼
      │   X (Twitter)
      ▼
data/generated/*.json ── 差分があれば bot がコミット
      │
      ▼
Astro build ── JSON をビルド時に読み込み静的 HTML 化
      │
      ▼
GitHub Pages (独自ドメイン vcha-antenna.com / DNS は Cloudflare)
```

### データ取得

- **YouTube**: `search.list` の live / upcoming / completed 3検索で候補を発見し(60分クールダウンでクォータ節約)、発見済み動画は `videos.list` で継続追跡します。タイトルまたは説明文に「VRChat」を含む配信だけを掲載します
- **Twitch**: VRChat カテゴリの配信中ライブを取得します。日本語配信は全件、非日本語は視聴者数上位50件。成人向け指定は除外します
- **ニコニコ生放送**: キーワード「VRChat」の検索結果(放送中+予約)を取得します。有料・フォロワー限定・成人向けタイトルは除外し、予約は30日先まで掲載します
- 取得の部分失敗時は前回データを保持し、プラットフォーム単位の失敗はその回の掲載省略に留めます(サイト全体は落ちません)
- `YOUTUBE_API_KEY` 未設定の環境では全プラットフォームが自動的にモックデータで動作します。実データ時に Twitch 認証情報が未設定なら Twitch のみスキップします

### X 自動ポスト

- 更新のたびに `scripts/digest.ts` が実行され、前回ポストから120分以上経過かつ日本語のライブ配信が1件以上あるときだけ投稿します(2時間毎の制御は GitHub Actions 側。IFTTT は Webhook を受けて X に投稿するだけ)
- 配信中の日本語配信から1件をランダムに紹介し(同じ配信の連続紹介は回避)、`?q=配信者名` 付きのサイトリンクを添えます
- 投稿済み状態は `data/generated/digest.json` でコミット管理され、CI をまたいで間隔が維持されます

## 技術スタック

Astro / TypeScript (strict) / YAML / YouTube Data API v3 / Twitch API / IFTTT Webhooks / GitHub Actions / GitHub Pages / Cloudflare (Registrar + DNS)

## 開発

```sh
npm install
cp .env.example .env   # API 認証情報を記入(YOUTUBE_API_KEY がなければモックで動作)
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動(http://localhost:4321/) |
| `npm run update` | 配信データ取得・`data/generated/` 更新 |
| `npm run digest -- --dry-run` | X ポスト本文のプレビュー(投稿しない) |
| `npm run build` | 本番ビルド |
| `npm test` | テスト実行 |
| `npm run check` | 型チェック(astro check + tsc) |

## 配信者の追加

配信者リストの登録は不要です。各プラットフォームの検索・カテゴリから条件に合う配信を自動取得し、配信者情報も取得データから生成します。

自動掲載から除外するチャンネルは `data/blocklist.yaml` に `channelId` を追加します(Twitch は `tw-` 、ニコ生は `nico-` 接頭辞付きの ID)。`note` は任意です。

```yaml
- channelId: UCxxxxxxxxxxxxxxxxxxxxxx
  note: 除外理由
```

## コミュニティ枠

トップページ末尾のコミュニティ枠(PR カード)は `data/sponsors.yaml` で管理しています。掲載のご相談は X の DM へどうぞ。

## 掲載について

本サイトはすべての VRChat 配信者・コンテンツを網羅しているわけではありません。また、取得の仕組み上、VRChat 以外のコンテンツが掲載されることがあります。掲載の削除(サイト・自動ポストとも)をご希望の場合は X [@hir0chan_vrc](https://x.com/hir0chan_vrc) までご連絡ください。

## 作者

**hir0chan** — [X @hir0chan_vrc](https://x.com/hir0chan_vrc) / [GitHub](https://github.com/hir0chan)
