# おすすめ配信ポスト+サイト内検索フィールド 実装レポート

日付: 2026-08-19_04:54
計画書: `_doc/実装ドキュメント/実装計画書/202608190435_featured_post_and_search.md`(codex レビュー2往復でクリア)
担当: コーディング codex / レビュー・検証 Claude

## 概要

X 定期ポストを「配信中の日本語配信から1件ランダム紹介+`?q=配信者名` パラメータ付きサイトリンク」形式へ刷新し、サイトに自由入力の検索フィールド(?q= ディープリンク対応)を追加した。

新ポスト形式(実データ dry-run):

```
👉️ 今おすすめのVRChat配信は?
【内輪用】VRChatの画面共有で作業配信をしてみよう(【内輪用】アネクメネの百姓)
https://vcha-antenna.com/?q=%E3%80%90%E5%86%85%E8%BC%AA...
現在3件がライブ配信中👀
#VRChat #ぶいちゃ配信アンテナ
```

## 変更ファイル

- 新規: `src/lib/search.ts`(表示可否判定の純関数)、`test/search.test.ts`
- 変更: `scripts/digest.ts`(新テンプレート・`selectFeatured`・`sanitizePostText` と長さ制限の分離・state 簡素化・旧 announced 系削除)、`scripts/models.ts`、`src/components/HomePage.astro`(検索欄+該当なしメッセージ+`data-stream-section`)、`src/components/StreamCard.astro`(`data-search`)、`src/layouts/Layout.astro`(検索適用 JS)、`src/lib/i18n.ts`(ja/en 文言)、`src/styles/global.css`、`test/digest.test.ts`(全面改訂)

## 主な仕様

- 選出: live×日本語の全件から1件ランダム(前回選出は候補2件以上のとき除外)。live が1件以上あれば2時間毎に毎回投稿(「新規あり」条件は廃止)
- `digest.json` は `{ lastPostedAt, lastFeaturedId }` に簡素化(旧 `announced` は読込時に無視され次回書込で消える)
- タイトル・配信者名は `sanitizePostText` で無害化(制御文字・bidi 制御・URL 風トークン・`@`/`#`/ドット類)し、タイトルは280残余予算で切り詰め
- 検索は「タイトル+配信者名」への部分一致(大文字小文字無視)。既存のプラットフォーム/日本語フィルタと AND。空グループ非表示・全滅時は「該当なし」表示。`?q=` は入力欄へ反映するだけで localStorage に保存しない

## 検証結果

| 検証 | 結果 |
|---|---|
| `npm test`(88件)/ `npm run check` / `npm run build` | ✅ 全パス |
| dry-run(新文面・?q= リンク・280以内) | ✅ |
| ?q= ディープリンク(入力済み+絞り込み済み、135枚中1枚表示) | ✅ dev サーバー実機確認 |
| 検索クリアで全件復帰・不一致時の「該当なし」表示 | ✅ |
| 既存フィルタとの AND(一致するが platform/日本語のみで隠れるケース) | ✅ |
| XSS(`?q="><img src=x onerror=...>`)が不成立(値として扱われるのみ) | ✅ |
| 英語ページ(/en/?q=、英語 placeholder・aria-label・該当なし文言、言語切替で q 非引き継ぎ) | ✅ |
| 既存フィルタ・既存テストの回帰 | ✅ |

## 運用メモ

- 紹介はランダムのため配信者間で偏りが出うる(長期的には均される)。特定配信者を外したい場合は従来どおり blocklist で対応
- 紹介した配信がポスト閲覧時点で終了している場合、リンク先は「該当なし」表示になる(入力を消せば全件表示)

## 確認したい事項

- 次回の実投稿(前回から120分経過後の cron)で新形式をご確認ください
- 「該当なし」文言・ポストの細部(👉️ の絵文字、タイトルと配信者名の区切り等)は変更可能です
