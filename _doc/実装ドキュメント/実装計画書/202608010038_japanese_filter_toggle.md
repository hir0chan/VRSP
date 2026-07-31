# 「日本語のみ」表示スイッチ 実装計画書

日付: 2026-08-01_00:38
種別: 計画型
状態: **実装完了**(2026-08-01)
担当: コーディング codex / レビュー・検証 Claude

## 1. 背景・目的

コンテンツ起点収集への転換で収集範囲が全世界になった。ユーザー指示により、閲覧者が**「日本語のみ」に表示を絞れるスイッチ**をトップページに実装する。あわせてフッターの「掲載をご希望の方は…」文言を自動掲載制の実態に合わせて削除する(ユーザー指示)。

## 3. 確定仕様

(§2 系はテンプレート上の提案型専用セクションのため省略)

| 項目 | 決定内容 |
|---|---|
| 日本語判定(データ層) | `Stream` に **optional の `isJapanese?: boolean`** を追加(後方互換: 欠落 = 判定不明として「日本語のみ」時も**表示する**側に倒す。isStream 型ガードは欠落を許容し非 boolean を拒否)。判定は youtube.ts の変換時に **title + description にかな文字が含まれるか**のヒューリスティック。文字範囲は**厳密に**: ひらがな `ぁ-ゖ`・カタカナ `ァ-ヺ`・半角カタカナ `ｦ-ｯｱ-ﾝ`(半角長音 `ｰ` を挟んで分割。`・` `ー` `ｰ` 等の記号は含めない。漢字のみは中国語の可能性があるため判定に使わない)。純関数 `isJapaneseContent(title, description)` として公開しテスト可能に |
| モック | mock.ts の生成分に isJapanese を付与。**トグルの動作確認ができるよう一部を非日本語(英語タイトル)で生成**する |
| UI: スイッチ | ヒーローと最初のセクションの間に右寄せの**トグルスイッチ**(`<input type="checkbox" id="ja-only-toggle">` + `<label for="ja-only-toggle">日本語のみ</label>` の明示的関連付け)を1つ設置。デザインはライトテーマのトーン(--line 枠・--accent-deep のオン状態)。`:focus-visible` 対応(モーション抑止は既存の全要素 transition 無効化ルールでカバー済みのため専用ルール不要)。**コントロールは初期 `hidden` とし JS が起動時に表示**する(JS 無効環境では操作できない見かけのスイッチを出さない = 全件表示のみ) |
| UI: フィルタ機構 | StreamCard に `data-ja="true/false"`(isJapanese 欠落は true 扱い)を付与。トグル ON で `<html>` に `data-ja-only` 属性を立て、CSS で `[data-ja-only] .stream-card[data-ja="false"] { display: none }`。**表示カードが0になった日付グループは `:has()` で丸ごと非表示**(`[data-ja-only] .date-group:not(:has(.stream-card[data-ja="true"])) { display: none }`)。セクション自体と件数バッジは常に表示。件数は全件数のままとするが、誤解軽減のためバッジに `aria-label` / `title` で「全◯件」と明示する(視覚は数字のみで不変) |
| 状態の復元と同期 | 2段構成: ①**head 内の同期 inline script** が localStorage を読み `<html>` に `data-ja-only` を即時復元(描画前=ちらつきなし)②**ページ末尾の inline script** が checkbox を表示し、`checked` を html 属性から同期したうえで `change` リスナーを登録。ON: 属性付与 + `localStorage.setItem("vrsp-ja-only","1")` / OFF: 属性除去 + `removeItem`。**localStorage の get/set/remove は try/catch で包み、例外時も属性切替(セッション内のフィルタ動作)は機能させる**(永続化だけ諦める) |
| フッター文言 | Layout.astro の注釈から「掲載をご希望の方は X @hir0chan_vrc までご連絡ください。」の一文を**削除**し、「掲載の削除をご希望の場合は X @hir0chan_vrc までご連絡ください。」に置き換え(削除窓口は維持)。README「掲載について」も同趣旨に修正 |
| 変更しないもの | scripts の収集ロジック(判定付与以外)・classify.ts・thumbnail.ts・generated スキーマの必須フィールド・ワークフロー |

## 4. 実装設計

- `scripts/youtube.ts`: `isJapaneseContent()` 追加、convertVideo で `isJapanese` 設定
- `scripts/models.ts`: `Stream.isJapanese?: boolean`
- `scripts/mock.ts`: isJapanese 付与(2件程度を英語タイトル・isJapanese: false に)
- `scripts/update.ts`: isStream 型ガードに isJapanese(optional boolean)を追加
- `src/components/StreamCard.astro`: `data-ja` 属性
- `src/pages/index.astro`: トグル UI + フィルタ用 CSS は global.css へ
- `src/layouts/Layout.astro`: head に localStorage 復元の同期 inline script、フッター文言修正
- テスト: isJapaneseContent(かな含む/漢字のみ/英語のみ/description のみかな/**記号のみ(・ー、半角 ｰ 含む)は非日本語**/**半角カタカナは日本語**)・convertVideo の isJapanese 付与・isStream の後方互換(欠落許容・非 boolean 拒否)

## 5. 検証計画

1. 単体テスト全パス・`npm run check` 0 errors・`npm run build` 成功
2. 実データで update → dev サーバー: トグル OFF で全件、ON で非日本語カードが消えること(現在海外配信が多数あるため実データで確認可能)。空になった日付グループの非表示。リロード後の状態復元。キーボード操作(Tab → Space で切替)
3. JS 無効時(chrome-devtools で scriptExecution 無効化 or 目視で noscript 挙動確認)に全件表示のままであること
4. フッター文言の確認(ローカル)

## 6. 影響範囲・リスク

- かなヒューリスティックの誤判定: 日本語話者が英語のみのタイトル・説明文で配信すると非日本語扱いになる(説明文まで見るため実害は少ない想定。欠落・不明は表示側に倒す)
- 件数バッジは全件数のまま(フィルタと不一致になるが v1 の割り切り。不評なら JS で更新する改修を別途)
- `:has()` は全モダンブラウザ対応済み(非対応の古いブラウザでは空グループが残るだけで実害なし)

## 7. 未決事項(デフォルト採用・変更可)

- デフォルトは OFF(全件表示)。日本語ユーザー主体なのでデフォルト ON も選べる(ユーザー判断があれば変更)
- スイッチの文言「日本語のみ」(代替: 「JP のみ」等)

## 8. 実施結果

- §3・§4 の確定仕様どおり、かな文字による日本語判定、後方互換な optional フィールド、モックの非日本語データ、CSS フィルタ、トグル状態の復元・永続化、件数バッジの補足、フッターと README の文言修正を実装した
- `npm run check`: 成功(0 errors / 0 warnings)
- `npm test`: 実行環境の tsx IPC ソケット制約で `EPERM`。指定の代替 `node --import tsx --test test/*.test.ts` は 32/32 成功
- `npm run build`: 成功(静的ページ1件)
- `YOUTUBE_API_KEY= node --import tsx scripts/update.ts`: モックモード成功。tracked 11件・表示11件・日本語9件・非日本語2件・判定欠落0件
- 生成後 HTML に `data-ja="false"` 2件、トグル、localStorage キー、件数バッジの `aria-label` / `title` が出力されることを確認した
- 指示に従い実 API と git 操作は実施していない
