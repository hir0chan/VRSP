# VRChat Schedule Portal

> Claude Code 開発指示書 (README.md)

## 1. プロジェクト概要

本プロジェクトは「VRChat系 YouTube 配信者向けホロジュール」を構築する。

### ゴール

-   VRChat系配信者のライブ予定を一覧化
-   NOW ON LIVE を最優先表示
-   GitHub Pages 上で無料公開
-   GitHub Actions による15分毎の自動更新
-   サーバ常駐・DB不要
-   保守コストを最小化

------------------------------------------------------------------------

## 2. 開発思想

最優先事項は以下。

1.  シンプル
2.  壊れにくい
3.  AIが理解しやすい
4.  将来拡張しやすい

過剰設計は禁止。

採用しないもの:

-   Kubernetes
-   Docker
-   Redis
-   Firebase
-   Prisma
-   ORM
-   WebSocket
-   SSR
-   Serverless Functions
-   RDB

------------------------------------------------------------------------

## 3. 技術スタック

-   Astro
-   TypeScript
-   GitHub Pages
-   GitHub Actions
-   YouTube Data API v3
-   YAML

------------------------------------------------------------------------

## 4. ディレクトリ

``` text
.
├── src/
│   ├── pages/
│   ├── layouts/
│   ├── components/
│   └── styles/
├── scripts/
│   ├── update.ts
│   ├── youtube.ts
│   ├── render.ts
│   └── models.ts
├── data/
│   ├── streamers.yaml
│   └── generated/
│       ├── streams.json
│       └── streamers.json
├── public/
├── .github/workflows/update.yml
└── README.md
```

------------------------------------------------------------------------

## 5. アーキテクチャ

``` text
GitHub Actions
        │
        ▼
YouTube Data API
        │
        ▼
scripts/update.ts
        │
        ▼
generated/*.json
        │
        ▼
Astro Build
        │
        ▼
GitHub Pages
```

データソースは YouTube のみ。

------------------------------------------------------------------------

## 6. streamers.yaml

``` yaml
- id: example
  name: Example
  youtubeChannelId: UCxxxxxxxx
  enabled: true
```

将来的に以下追加可能な構造にする。

-   X
-   Booth
-   VRChat Profile
-   アイコン
-   説明
-   タグ

------------------------------------------------------------------------

## 7. データモデル

### Streamer

``` ts
interface Streamer {
 id:string;
 name:string;
 youtubeChannelId:string;
 enabled:boolean;
}
```

### Stream

``` ts
type Status =
 "upcoming"|
 "live"|
 "ended";

interface Stream {
 id:string;
 streamerId:string;
 title:string;
 thumbnail:string;
 url:string;
 status:Status;
 scheduledStart?:string;
 actualStart?:string;
 actualEnd?:string;
 viewers?:number;
}
```

------------------------------------------------------------------------

## 8. 更新アルゴリズム

15分毎に実行。

1.  streamers.yaml 読込
2.  各チャンネル取得
3.  新しい動画取得
4.  ライブ情報取得
5.  generated 更新
6.  Astro build
7.  Pages deploy

失敗しても他チャンネルの処理は継続。

------------------------------------------------------------------------

## 9. 画面仕様

トップページ

1.  NOW ON LIVE
2.  TODAY
3.  UPCOMING

### NOW ON LIVE

大きいカード表示。

表示内容

-   サムネ
-   タイトル
-   配信者
-   開始時刻
-   視聴ボタン

### TODAY

開始時刻順。

### UPCOMING

日付ごと。

------------------------------------------------------------------------

## 10. デザイン

シンプル。明るく軽いライトテーマ。アクセントは赤のみ。ホロジュールを参考にするがコピーしない。レスポンシブ対応。

------------------------------------------------------------------------

## 11. GitHub Actions

15分毎。

-   checkout
-   npm ci
-   update
-   astro build
-   deploy pages

APIキーは GitHub Secrets。

------------------------------------------------------------------------

## 12. コーディング規約

-   strict TypeScript
-   関数は小さく
-   副作用を分離
-   any禁止
-   コメントは「なぜ」を書く

------------------------------------------------------------------------

## 13. エラー処理

API失敗時は既存 generated を残す。

1チャンネル失敗で全体停止しない。

------------------------------------------------------------------------

## 14. 将来拡張

-   配信者プロフィール
-   イベント情報
-   Booth
-   配信タグ
-   お気に入り
-   RSS
-   検索

------------------------------------------------------------------------

## 15. AIへの要求

Claude Code は以下を遵守すること。

-   小さなコミット
-   リファクタは最後
-   実装前にディレクトリ作成
-   TODOを残さない
-   動作確認を優先
-   不要ライブラリを導入しない

実装が複数案ある場合は「最も単純な案」を採用する。

MVP完成後にのみ改善提案を行う。
