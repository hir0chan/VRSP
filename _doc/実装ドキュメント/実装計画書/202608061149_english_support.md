# 英語対応(JA/EN 切替) 実装計画書(提案)

日付: 2026-08-06_11:49
種別: 提案型 → 計画型(2026-08-06 ユーザー合意「推奨案で進行を」により §3 以降を追記)
状態: **実装・検証完了**(2026-08-06。文末「実施結果」を参照)
担当: 提案・検証 Claude / コーディング codex

## 1. 背景・目的

ユーザー要望: ヘッダー右に JA/EN 切替を置き、UI の日本語文字列を適宜英語化する。Twitch / ニコ生対応で非日本語圏の配信・閲覧者が増えており、英語 UI の受け皿を作る。配信タイトル・配信者名などの動的コンテンツは原文のまま(翻訳しない)。

## 2-1. 技術的可否

**結論: ⭕ 可能**(依存追加ゼロ・静的ビルドのまま実現できる)

### 翻訳対象インベントリ(2026-08-06 実測)

| 箇所 | 内容 |
|---|---|
| `src/pages/index.astro` | ヒーロー見出し「今日、バーチャルのどこへ行く?」・コピー、フィルタラベル(すべて / ニコ生 / 日本語のみ。YouTube・Twitch は共通)、**非表示 legend「プラットフォーム」**、セクション見出し(本日の配信 / 今後の配信。eyebrow の NOW ON LIVE 等は既に英語)、空状態文言2件 |
| `src/layouts/Layout.astro` | `<title>`・meta description・OG 系(og:locale 含む)・サイト名・「最終更新」・フッター注意書き/作者行・brand の aria-label |
| `src/components/StreamCard.astro` | aria-label「〜の配信ページを見る」・「配信ページへ」・alt「ニコニコ生放送」 |
| `src/components/SectionHeader.astro` | 件数バッジの aria-label / title「**全◯件**」(動的数値の補間あり) |
| `src/lib/classify.ts` | 日付グループラベル(`ja-JP` 固定の Intl フォーマッタ、`8月5日(水)` 形式)と「日付未定」→ **locale 引数化が必要** |
| 時刻表示 | StreamCard の HH:mm と Layout の更新日時(いずれも `ja-JP` 固定)→ locale 引数化(タイムゾーンは JST のまま) |

- 補間を含む文言(「全◯件」「◯◯の配信ページを見る」)は辞書をテンプレート関数(`(n: number) => string` 等)として型付けする
- 対象外: `public/images/thumbnail-*.svg` 内の日本語(カード側で `alt=""` の装飾扱いのため UI に露出しない)、classify.ts の例外メッセージ・コードコメント(利用者向けでない)

## 2-2. 実現方式の比較

### 案A: 静的2ページ生成 — `/VRSP/`(日本語)+ `/VRSP/en/`(英語)(推奨)

共有コンポーネントに `locale` prop を通し、`src/pages/en/index.astro` を追加して両言語をビルド時に生成する。ヘッダー右の JA/EN はページ間リンク(ボタン風の見た目)。

- ⭕ **言語切替に追加 JS 不要**・ちらつきなし(フィルタ復元等の既存 JS はそのまま)。サーバーレンダリング済みの文字列(日付ラベル・aria-label・meta)も自然に言語別になる
- ⭕ SEO 対応可能(`hreflang` 相互リンク・言語別 description・`og:locale`)。英語圏からの流入導線になる
- ⭕ 既存アーキテクチャ(ビルドのみ・サーバなし)に完全に乗る。依存追加ゼロ
- ❌ ページが2枚になりビルド対象が増える(実害は僅少)

**ページ構造の共有方法**: 画面構造の複製はしない。現在 `index.astro` にあるデータ読込〜画面構造を **`src/components/HomePage.astro`(仮称)として1つに抽出**し、`index.astro` と `en/index.astro` の2 route は `locale` を渡すだけの薄いファイルにする(マークアップ差分の発生を構造的に防ぐ)。

**URL・メタの完成形**(GitHub Pages サブパス配下。リンクは必ず `BASE_URL` 起点で生成):

| 項目 | JA | EN |
|---|---|---|
| canonical / og:url | `https://hir0chan.github.io/VRSP/` | `https://hir0chan.github.io/VRSP/en/` |
| og:locale / alternate | `ja_JP` / alternate `en_US` | `en_US` / alternate `ja_JP` |
| hreflang | 両ページに `ja` / `en` 相互リンク+`x-default`(JA を指す) |
| ブランドリンク | 現在言語のホームへ(JA→`/VRSP/`、EN→`/VRSP/en/`) |
| sitemap | 静的 `public/sitemap.xml` に2 URL を記載(依存追加なし)。robots.txt はプロジェクト Pages ではオリジン直下に置けず機能しないため対象外(サイトマップは Search Console 等へ直接登録する運用) |

(参考: Astro 組み込み i18n ルーティングも検討したが、2言語・各1ページでは設定と抽象化が増えるだけのため手動2 route が最も単純と判断)

### 案B: クライアント切替(1ページ+JS 辞書で文字列差し替え)

既存トグルと同じ localStorage + 属性切替で、JS が textContent を辞書から差し替える。

- ⭕ URL がひとつのまま
- ❌ サーバーレンダリング済みの日付グループラベル・aria-label・meta・title の差し替えが複雑で漏れやすい。JS 無効時は英語にできない。切替時のちらつき。SEO 不可(英語がクローラに見えない)
- ❌ 辞書と DOM の対応管理が増え、既存の「表示層はシンプル」という構成に反する

**結論: 案A を推奨。** 静的サイトの言語切替はページを分けるのが最も単純かつ確実で、SEO の副次効果も得られる。

## 2-3. 実装前に確認したい点

1. **URL 設計**: `/VRSP/en/` の静的別ページ方式でよいか(推奨)。ヘッダーの JA/EN はリンク切替(現在言語を強調表示)
2. **初回言語の自動判定**: しない(推奨。リンクを置くだけ。ブラウザ言語での自動リダイレクトは複雑さと誤爆の割に益が薄い)/ するなら localStorage 記憶+次回訪問時に前回言語へ誘導
3. **EN ページの「日本語のみ」フィルタ既定値**: JA ページは現行どおり ON、**EN ページは OFF を推奨**(英語話者は非日本語配信も見たいはず)。実現のため localStorage `vrsp-ja-only` を**三値に変更**する — `"1"` = 明示 ON / `"0"` = 明示 OFF / キーなし = ページ既定値(JA: ON、EN: OFF)。ON 操作時にキー削除する現行実装のままでは EN で ON にしても再読込で OFF に戻るため、ON 時は `"1"` を保存する形に改める(既存の `"0"` 保存ユーザーは OFF のまま互換、キーなしユーザーは JA で従来どおり ON)
4. **日時表記**: JST 固定のまま英語表記にする(推奨)。Intl は `en-US` を採用し、日付グループは `weekday: "short", month: "short", day: "numeric"` の素の出力(例: `Wed, Aug 5`)、時刻は 24時間制(`hourCycle: "h23"`)を維持。期待文字列はテストで固定。閲覧者タイムゾーン変換は別件(スコープ外を推奨)
5. **英語サイト名**: 既存の英名「VRChat Stream Antenna」を使用(ヒーローの eyebrow に既出)。ロゴ・ブランド表記は「ぶいちゃ配信アンテナ / VRChat Stream Antenna」のどちらを主にするか
6. **翻訳文言の確定方法**: 一次訳を Claude が作成しユーザーがレビュー(推奨)
7. **フィルタ相互作用は既存仕様を維持**(過剰設計回避のため次を明記): プラットフォーム選択(`vrsp-platform`)は言語間で共通キーのまま維持/日本語×プラットフォームの AND 合成・空日付グループ非表示 CSS は不変/件数バッジはフィルタ前の全件数のまま/フィルタで live・today が0件になってもセクション・空状態の動的更新はしない
8. **OGP 画像**: 現行 `ogp.png` は日本語テキストのため EN ページの SNS プレビューも日本語画像になる。初版は共通画像を許容し(推奨)、英語版画像は必要になったら別件で用意

## 3. 確定仕様(2026-08-06 ユーザー合意: §2-3 の全推奨案を採用)

| 項目 | 決定内容 |
|---|---|
| 方式 | 案A: 静的2ページ生成(`/VRSP/` = 日本語、`/VRSP/en/` = 英語)。画面本体は `HomePage.astro` に抽出し route は locale を渡すのみ |
| 切替 UI | ヘッダー右に JA / EN リンク(現在言語を強調表示、既存セグメントと同系の見た目)。ブランドリンクは現在言語のホームへ。自動リダイレクトなし |
| ja-only 既定値 | localStorage `vrsp-ja-only` を三値化(`"1"` 明示ON / `"0"` 明示OFF / キーなし=ページ既定。JA: ON、EN: OFF)。ON 操作時は `"1"` を保存する形に変更(既存 `"0"` ユーザーは OFF のまま互換) |
| フィルタ | プラットフォーム選択は言語間共通キー維持。AND 合成・空グループ CSS・件数バッジ(全件数)・空状態は既存仕様のまま |
| 日時 | JST 固定。EN は `en-US` で日付グループ `Wed, Aug 5`(weekday short / month short / day numeric)、時刻・更新日時は 24時間制(`hourCycle: "h23"`)。期待文字列をテストで固定 |
| メタ・SEO | §2-2 の URL 完成形表のとおり(canonical / og:url / og:locale+alternate / hreflang ja・en・x-default、すべて BASE_URL 起点)。`public/sitemap.xml` に2 URL(robots.txt は対象外 — §2-2 の表を参照) |
| サイト名・OGP | EN は「VRChat Stream Antenna」。OGP 画像は初版は共通(日本語版) |
| 翻訳 | 一次訳を Claude が作成し、実装レポートに全文言の対訳表を載せてユーザーレビューを受ける |
| 変更しないもの | scripts 層(データ取得)すべて・フィルタ機構の挙動・classify の分類ロジック(ラベル生成の locale 化のみ)・CI 定義 |

## 4. 実装設計

1. `src/lib/i18n.ts` 新規: 型付き辞書(`ja` / `en`)と参照用純関数。補間文言はテンプレート関数として型付け。キーは上記インベントリ全件
2. `src/lib/classify.ts`: 日付ラベル生成の locale 引数化(既定 ja で後方互換)+期待文字列テスト(ja / en 両方)
3. **`src/components/HomePage.astro` 新規**: 現 `index.astro` の本体を抽出。`index.astro` / `en/index.astro` は locale を渡すだけの薄い route に
4. `Layout.astro` / `StreamCard.astro` / `SectionHeader.astro`: `locale` prop 化と辞書参照への置換。`<html lang>`・canonical・og:url・og:locale(+alternate)・hreflang(ja / en / x-default)をページ別に生成(すべて BASE_URL 起点)
5. ヘッダー右に JA/EN 切替リンク(現在言語を強調。ブランドリンクは現在言語のホームへ)
6. localStorage `vrsp-ja-only` の三値化(§2-3-3)+ EN ページの既定 OFF(head 内 inline script の既定分岐)
7. `public/sitemap.xml`(静的2 URL。robots.txt は対象外)
8. 検証: 両ページのビルド・表示・メタ(canonical / hreflang / og)確認、フィルタ回帰(JA→EN→JA の状態維持、既存 `"0"` ユーザー互換、EN 既定 OFF で ON にして再読込しても ON が維持されること)、`npm run check` / `npm test`

## 5. 検証計画

1. **正常系**: `npm run check` 0 errors・`npm test` 全パス(classify の en ラベル期待文字列含む)・`npm run build` で2ページ生成。dev サーバーで JA/EN 両ページの全文言・日付/時刻表記・切替リンク動作を確認
2. **メタ**: 両ページの `<html lang>`・canonical・og:url・og:locale(+alternate)・hreflang(ja/en/x-default)・title・description が §3 の完成形と一致すること。sitemap.xml の2 URL
3. **フィルタ境界**: EN 初回訪問(キーなし)で日本語のみ OFF/JA 初回で ON。EN で ON→再読込で ON 維持(`"1"` 保存)。既存 `"0"` 保存状態で両ページとも OFF。JA で ON(キーなし旧状態相当)→EN へ遷移で OFF(ページ既定)→明示 ON→JA に戻って ON 維持。プラットフォーム選択が言語間で維持されること
4. **回帰**: 既存フィルタ(プラットフォーム・AND 合成・空グループ非表示・320px レスポンシブ)が JA/EN 両ページで動作すること

## 8. 改修規模の見積

| 項目 | 内容 | 目安 |
|---|---|---|
| 辞書+classify locale 化 | i18n.ts 新規・classify 引数化・テスト | 0.3日 |
| コンポーネント locale 対応 | Layout / index / StreamCard / SectionHeader | 0.3日 |
| EN ページ+切替 UI+SEO | en/index.astro・ヘッダーボタン・hreflang | 0.3日 |
| 翻訳・検証 | 一次訳、両ページ検証、フィルタ回帰 | 0.2日 |

合計 約1日。依存追加なし・scripts 層(データ取得)への変更なし。

## 9. 実施結果(2026-08-06 実装・検証完了)

### 実装

§3・§4 のとおり実装(コーディング codex / レビュー・検証 Claude)。計画との差分は2点: ①レビュー指摘により更新日時の `<time>` 要素は日時のみを含む形に修正(接頭辞は辞書の `updatedPrefix` に分離)②EN の「Niconico」ラベルでセグメント4個が 320px を超えたため、374px 以下でセグメントを縮小するメディアクエリを追加。

- 新規: `src/lib/i18n.ts`(型付き対訳辞書)、`src/components/HomePage.astro`(画面本体の共通化)、`src/pages/en/index.astro`、`public/sitemap.xml`
- 変更: `Layout.astro`(言語別メタ・canonical・hreflang・JA/EN 切替・ja-only 三値化)、`StreamCard.astro` / `SectionHeader.astro`(locale prop)、`classify.ts`(日付ラベル locale 引数化・後方互換)、`global.css`(切替 UI・狭幅ヘッダー・セグメント縮小)、`test/classify.test.ts`(ja/en 期待文字列)

### 検証結果

| 検証 | 結果 |
|---|---|
| `npm run check` / `npm test` / `npm run build` | ✅ 0 errors・54件全パス・2ページ生成 |
| メタ(両ページの lang / canonical / og:url / og:locale+alternate / hreflang ja・en・x-default / title / description) | ✅ §2-2 完成形どおり |
| EN 初回=日本語のみ OFF・JA 初回=ON(キーなし) | ✅ |
| EN で明示 ON → `"1"` 保存 → JA 遷移後も ON 維持 | ✅ |
| 明示 OFF `"0"` の両ページ互換・プラットフォーム選択の言語間維持 | ✅ |
| 英語表記(`Wed, Aug 5`・`Last updated: MM/DD/YYYY, HH:mm JST`・24時間制) | ✅ 実ブラウザ・テスト両方 |
| 320px(JA / EN 両ページ) | ✅ 横はみ出しなし(ヘッダー2段組・セグメント縮小) |

### 残課題・補足

- OGP 画像は日本語版を共用(合意どおり)。英語版が必要になれば別件
- sitemap.xml は Search Console への登録をユーザー側で実施
