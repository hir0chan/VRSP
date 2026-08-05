# プラットフォームフィルタ 実装計画書

日付: 2026-08-06_00:28
種別: 計画型
状態: **実装・検証完了**(2026-08-06。文末「実施結果」を参照)
担当: コーディング codex / レビュー・検証 Claude

## 1. 背景・目的

Twitch 対応(202608051558_twitch_support)により初期表示されるコンテンツが大幅に増えた(LIVE セクションだけで約50件)。閲覧者が **YouTube / Twitch のどちらかに表示を絞れるフィルタ**をトップページに追加し、目当てのプラットフォームの配信を見つけやすくする。フィルタ項目の候補比較はユーザーと対話済みで、プラットフォームフィルタのみ採用が確定している。

## 3. 確定仕様

(方式はユーザーと合意済みのため §2 系は省略。既存「日本語のみ」トグル(202608010038)のパターンを踏襲する)

| 項目 | 決定内容 |
|---|---|
| UI | 既存 `.filter-controls`(ヒーロー直下・右寄せ)内の「日本語のみ」トグルの**左**に、**セグメントコントロール**(すべて / YouTube / Twitch)を設置。実体は `<fieldset>` 内の `<input type="radio" name="platform-filter">` 3個 + `<label>`(明示的関連付け)に加え、**`<legend>プラットフォーム</legend>` を視覚的非表示(sr-only 相当のクリップ手法)で設置**し支援技術にグループの用途を伝える。fieldset のデフォルト枠・余白は CSS でリセット。視覚は角丸ピル型・選択中は `--accent-deep` 地に白文字(コントラスト規則準拠)、非選択は `--surface` 地・`--line` 枠。`:focus-visible` 対応。デフォルトは「すべて」 |
| レスポンシブ | `.filter-controls` に `flex-wrap: wrap` と `gap` を設定し、320px 幅でもはみ出し・密着なく折り返して操作できること(現状は右寄せのみで間隔・折り返し未定義のため本改修で追加) |
| JS 無効時 | 既存トグルと同じく `.filter-controls` は初期 `hidden`、JS が起動時に表示(JS 無効環境では操作できないコントロールを出さない = 全件表示) |
| フィルタ機構 | StreamCard に `data-platform="youtube" \| "twitch"` を付与(`stream.platform` 欠落は youtube 扱い = データモデルの規約どおり)。選択時に `<html>` へ `data-platform-filter="youtube" \| "twitch"` を設定(「すべて」は属性除去)。CSS: `[data-platform-filter="youtube"] .stream-card[data-platform="twitch"] { display: none }` とその逆。既存の `data-ja-only` と**属性が独立しているため AND 合成が自動で成立**する |
| 空グループの扱い | 日付グループの丸ごと非表示は「表示カードが0のグループ」を隠す。**併用時は同一カードが両条件を満たすかを判定する必要がある**(条件別の `:has()` を独立に書くと、日本語の Twitch カードと非日本語の YouTube カードが混在するグループが「日本語のみ+YouTube」で残ってしまう)ため、フィルタ状態の組み合わせを列挙した5ルールで判定する: `[data-ja-only]:not([data-platform-filter])` は `[data-ja="true"]`、`[data-platform-filter="youtube"]:not([data-ja-only])` は `[data-platform="youtube"]`、同 twitch、`[data-ja-only][data-platform-filter="youtube"]` は `[data-ja="true"][data-platform="youtube"]`、同 twitch — 各状態で該当カードを `:has()` に持たない `.date-group` を `display: none`(既存の ja-only 単独ルールはこの列挙に置き換える)。セクション自体と件数バッジは常に表示(既存の割り切りを維持) |
| 件数バッジ | 静的な全件数のまま(202608010038 の割り切りを踏襲。`aria-label` / `title` の「全◯件」表記で誤解を軽減済み) |
| 状態の復元と同期 | 既存と同じ2段構成: ① head 内同期 inline script が localStorage キー `vrsp-platform`("youtube" / "twitch" のみ有効値)を読み `<html>` に描画前復元 ② ページ末尾 inline script がコントロール表示・checked 同期・`change` リスナー登録。「すべて」選択で `removeItem`。localStorage アクセスは try/catch(既存と同じく永続化のみ諦める)。**不正な保存値は無視して「すべて」扱い** |
| コントロール表示条件 | 末尾 script では**トグルとセグメントを独立に初期化**し、いずれか一方の初期化に成功すれば `.filter-controls` を表示する(片方の DOM 欠落時に全フィルタ UI が消えることを防ぐ) |
| 変更しないもの | scripts 層すべて(データ取得・モデル・モック)・classify.ts・thumbnail.ts・generated スキーマ・ワークフロー・既存「日本語のみ」トグルの挙動 |

### 成立性の根拠(調査済み)

- `Stream.platform?: "youtube" | "twitch"` は実装済みで、表示用 `streams` に Twitch 分が入っている(実データ・モックとも両プラットフォーム混在を確認)
- StreamCard は本日のアイコン対応で `stream.platform === "twitch"` 分岐を既に持ち、`data-ja` 属性付与の前例がある(`src/components/StreamCard.astro:22`)
- `data-ja-only` の2段 inline script・CSS 属性フィルタ・`:has()` による空グループ非表示は稼働中(`src/layouts/Layout.astro:55-61,121-138`、`src/styles/global.css`)

## 4. 実装設計

- `src/components/StreamCard.astro`: ルート `<article>` に `data-platform` 属性を追加(欠落時 "youtube")
- `src/pages/index.astro`: `.filter-controls` 内にセグメントコントロールの radio group を追加
- `src/layouts/Layout.astro`: ① head 同期 script に `vrsp-platform` 復元を追記 ② 末尾 script に radio の同期・change 処理を追記(既存トグル処理と同一 script 内にまとめる)
- `src/styles/global.css`: セグメントコントロールの見た目・`[data-platform-filter=…]` の表示制御・空グループ `:has()` ルールの一般化
- テスト: 表示層のみの変更で純関数の追加はないため単体テスト追加なし(既存テストの回帰確認のみ)

## 5. 検証計画

1. **正常系**: `npm run check` 0 errors・`npm test` 全パス・`npm run build` 成功。dev サーバーで YouTube 選択→Twitch カードが消える/Twitch 選択→YouTube カードが消える/すべて→全件復帰。リロードで状態復元。日本語のみ ON との併用(AND)で両条件が効くこと
2. **異常系**: `localStorage.setItem("vrsp-platform", "garbage")` 後にリロードして全件表示(すべて選択状態)になること。localStorage の get/set が例外を投げる状況(DevTools で `Storage.prototype` を差し替え)でもページ内のフィルタ切替自体は機能すること
3. **境界**: フィルタで日付グループが空になった場合にグループ見出しごと消えること。**併用の反例ケース**: 日本語 Twitch カードと非日本語 YouTube カードのみのグループが「日本語のみ+YouTube」で丸ごと消えること(条件を別々のカードが満たすケース)。320px 幅でコントロールがはみ出さず折り返すこと。キーボード操作(Tab → 矢印キーで radio 切替)
4. **回帰**: 日本語のみトグル単独の挙動が従来どおりであること(ON/OFF・永続化・空グループ非表示)

## 6. 影響範囲・リスク

- 表示層のみの変更。scripts 層・データ生成・CI に影響なし
- LIVE セクションがフィルタで全滅した場合もセクション見出しは残る(既存の割り切りと同じ。空状態文言は出ないが実害は小さい)
- radio の `name` 重複はページ内に本コントロール1つのみなので問題なし

## 7. 未決事項(デフォルト採用・変更可)

- セグメントのラベル表記は「すべて / YouTube / Twitch」(代替: アイコン併記。まずはテキストのみで軽く)

## 9. 実施結果(2026-08-06 実装・検証完了)

### 実装

計画どおり表示層4ファイルのみ変更(コーディング codex / レビュー・検証 Claude)。計画との差分なし。

- `src/components/StreamCard.astro`: ルートに `data-platform`(欠落時 "youtube")
- `src/pages/index.astro`: `.filter-controls` 内に fieldset + sr-only legend「プラットフォーム」+ radio 3個のセグメントコントロール
- `src/layouts/Layout.astro`: head 同期 script に `vrsp-platform` の値検証付き復元、末尾 script にトグルとセグメントの独立初期化(いずれか成功で `.filter-controls` 表示)
- `src/styles/global.css`: セグメントの見た目(選択中 `--accent-deep` 地・白文字)、カード表示制御2ルール、空グループ非表示の5ルール列挙(旧 ja-only 単独ルールを置換)、`.filter-controls` の flex-wrap / gap、fieldset リセット

### 検証結果

| 検証 | 結果 |
|---|---|
| `npm run check` / `npm test` / `npm run build` | ✅ 0 errors・全パス・成功 |
| YouTube / Twitch / すべて の切替(実データ YT69件・TW34件) | ✅ 各状態で対象外カード非表示・復帰 |
| リロード後の状態復元(youtube 保存時) | ✅ 属性・radio とも復元、TW 0件 |
| 不正保存値 "garbage" | ✅ 全件表示・「すべて」選択 |
| localStorage setItem 例外時 | ✅ ページ内フィルタ動作は維持 |
| 日本語のみ併用(AND) | ✅ 非日本語 YT カード 0件 |
| 併用の反例(日本語TW+非日本語YTのみのグループ) | ✅ 合成 DOM で「日本語のみ+YouTube」時に display:none を確認(実データの日付グループに Twitch は現れないため合成で検証) |
| ja-only 単独の空グループ回帰(7/30 非日本語のみ) | ✅ 非表示 |
| 320px(デバイスエミュレーション) | ✅ 横はみ出しなし・折り返し表示 |

### 変更ファイル一覧

- 変更: `src/components/StreamCard.astro`, `src/pages/index.astro`, `src/layouts/Layout.astro`, `src/styles/global.css`

### 残課題・補足

- 件数バッジは計画どおり静的全件数のまま(既存の割り切りを踏襲)
- キーボード操作はネイティブ radio グループの矢印キー遷移に依存(独自実装なし)
