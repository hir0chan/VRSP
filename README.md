# VRChat Stream Schedule Portal

VRChat系配信者のライブ配信と今後の配信予定を、ひとつの場所にまとめたスケジュールポータルです。

**🌐 https://hir0chan.github.io/VRSP/**

![VRChat Stream Schedule Portal](public/images/ogp.png)

## 特徴

- **NOW ON LIVE** — 配信中のライブを最優先で大きく表示
- **本日の配信 / 今後の配信** — 配信予定を JST の日付ごとに整理
- **15分毎の自動更新** — GitHub Actions が YouTube Data API v3 から取得し、自動で再ビルド・再デプロイ
- **完全静的・メンテナンスフリー** — サーバ常駐なし、データベースなし。GitHub Pages のみで稼働

## 仕組み

```text
GitHub Actions (15分毎)
      │
      ▼
YouTube Data API v3 ── scripts/update.ts が取得
      │                 (クォータ節約設計: 約1〜2unit/チャンネル)
      ▼
data/generated/*.json ── 差分があれば bot がコミット
      │
      ▼
Astro build ── JSON をビルド時に読み込み静的 HTML 化
      │
      ▼
GitHub Pages
```

- 取得失敗時は前回データを保持し、1チャンネルの失敗で全体は止まりません
- `YOUTUBE_API_KEY` 未設定の環境では自動的にモックデータで動作します

## 技術スタック

Astro / TypeScript (strict) / YAML / YouTube Data API v3 / GitHub Actions / GitHub Pages

## 開発

```sh
npm install
cp .env.example .env   # YouTube Data API キーを記入(なければモックで動作)
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動(http://localhost:4321/VRSP/) |
| `npm run update` | 配信データ取得・`data/generated/` 更新 |
| `npm run build` | 本番ビルド |
| `npm test` | テスト実行 |
| `npm run check` | 型チェック(astro check + tsc) |

## 配信者の追加

`data/streamers.yaml` にエントリを追加して push するだけです。

```yaml
- id: example            # 一意な英小文字 ID
  name: 表示名
  youtubeChannelId: UCxxxxxxxxxxxxxxxxxxxxxx
  enabled: true
```

## 掲載について

本サイトはすべての VRChat 配信者・コンテンツを網羅しているわけではありません。また、取得の仕組み上、VRChat 以外のコンテンツが掲載されることがあります。掲載のご希望・削除のご依頼は X [@hir0chan_vrc](https://x.com/hir0chan_vrc) までご連絡ください。

## 作者

**hir0chan** — [X @hir0chan_vrc](https://x.com/hir0chan_vrc) / [GitHub](https://github.com/hir0chan)
