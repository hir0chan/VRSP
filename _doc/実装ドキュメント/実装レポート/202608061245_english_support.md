# 英語対応(JA/EN 切替) 実装レポート

日付: 2026-08-06_12:45
計画書: `_doc/実装ドキュメント/実装計画書/202608061149_english_support.md`(提案型→計画型。レビュークリア済み、実施結果追記済み)
担当: 提案・検証 Claude / コーディング codex

## 概要

サイトを **2言語の静的2ページ構成**にした: `/VRSP/`(日本語)+ `/VRSP/en/`(英語)。ヘッダー右に JA/EN 切替(現在言語をハイライト)。画面本体は `HomePage.astro` に共通化し、両ページはビルド時に生成される(言語切替に JS 不要・依存追加ゼロ)。配信タイトル・配信者名は原文のまま。

## 主な仕様

- **翻訳辞書** `src/lib/i18n.ts`: UI 全文言(aria-label・meta 含む)を型付きで一元管理
- **EN ページの「日本語のみ」既定 OFF**: localStorage `vrsp-ja-only` を三値化(`"1"` 明示ON / `"0"` 明示OFF / キーなし=ページ既定)。既存ユーザーの状態は互換維持。プラットフォーム選択は言語間共通
- **日時**: JST 固定のまま英語表記(`Wed, Aug 5`、24時間制)
- **SEO**: ページ別 canonical / og:url / og:locale(+alternate)/ hreflang(ja・en・x-default)/ `sitemap.xml`(2 URL)。※Search Console への sitemap 登録はお願いします

## 検証

`npm run check` 0 errors・テスト54件全パス(en 日付ラベルの期待文字列含む)・ビルドで2ページ生成。実ブラウザで両ページの全文言・フィルタ境界(EN 初回 OFF / 明示 ON の言語間維持 / `"0"` 互換)・320px レスポンシブ(EN の Niconico ラベル起因のはみ出しを修正済み)・メタ出力を確認。

## 対訳表(ユーザーレビューをお願いします)

| 日本語(現行) | 英語(一次訳) |
|---|---|
| ぶいちゃ配信アンテナ \| VRChatのライブ配信・配信予定まとめ | VRChat Stream Antenna \| VRChat Live Streams & Schedule |
| (meta) VRChat系配信者のライブ配信と今後の配信予定をひとつにまとめたスケジュールポータルです。 | Live streams and upcoming broadcasts from VRChat streamers — all in one place. |
| ぶいちゃ配信アンテナ(サイト名・ブランド) | VRChat Stream Antenna |
| 今日、バーチャルの どこへ行く? | Where in the virtual world will you go today? |
| VRChatを旅する配信者たちのライブと、これから始まる配信をひとつの場所で。 | Live streams from VRChat streamers and what's coming next — all in one place. |
| 本日の配信 / 今後の配信 | Today's Streams / Upcoming Streams |
| 本日の配信予定はありません。/ 今後の配信予定はありません。 | No streams scheduled for today. / No upcoming streams scheduled. |
| すべて / ニコ生 / 日本語のみ / (legend)プラットフォーム | All / Niconico / Japanese only / Platform |
| 最終更新: | Last updated: |
| 全◯件 | ◯ total |
| 配信ページへ / ◯◯の配信ページを見る | Watch stream / Open the stream page for ◯◯ |
| 日付未定 | Date TBD |
| ニコニコ生放送(alt) | Niconico Live |
| フッター注意書き(網羅性・削除窓口・GA) | This site does not cover every VRChat streamer or every piece of content, and non-VRChat content may occasionally appear due to how data is collected. To request removal of a listing, please contact @hir0chan_vrc on X. This site uses Google Analytics to understand site traffic. |
| ぶいちゃ配信アンテナ by hir0chan | VRChat Stream Antenna by hir0chan |

## ユーザーに確認したい事項

- 上の対訳表の文言レビュー(修正があれば辞書 `src/lib/i18n.ts` の該当キーを直すだけです)
  - OKです
- Search Console 等への `https://hir0chan.github.io/VRSP/sitemap.xml` の登録(任意)
  - OK。あなたが進行可能ならやって
- OGP 画像は日本語版共用(合意どおり)。英語版を作る場合は別件で
  - それでOK

問題なければpushまで進行
