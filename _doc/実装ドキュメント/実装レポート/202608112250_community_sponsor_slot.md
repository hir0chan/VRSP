# コミュニティ枠(スポンサーカード)+ 支援導線 実装レポート

日付: 2026-08-11_22:50
計画書: `_doc/実装ドキュメント/実装計画書/202608112245_community_sponsor_slot.md`(計画型。codex レビュー2巡で承認、実施結果追記済み)
担当: 計画・検証 Claude / コーディング codex

## 概要

広告方針の決定(コミュニティとのつながり重視、C 機材紹介・D 直販スポンサー枠・E 支援導線)を受けた **Phase 1** として、ページ下部に**コミュニティ枠セクション**とフッターの**支援リンク差し込み口**を追加した。外部広告スクリプトは一切使わず、掲載データは `data/sponsors.yaml` の手編集 → ビルド時静的埋め込み(依存追加ゼロ)。

- **掲載カード**: 「PR」バッジ(有償掲載の明示・ステマ規制対応)+ 名前 + 紹介文(ja/en)+ 外部リンク(`rel="noreferrer nofollow sponsored"`)
- **募集カード**: 掲載0件でも常設。「この枠に掲載しませんか？」→ X(@hir0chan_vrc)の DM へ直リンク
- **掲載期限**: `until: yyyy-MM-dd`(任意)。JST 日付の文字列比較で判定し、期限日経過後の次回ビルドで自動的に掲載終了(15分毎 cron が再ビルドするため運用操作不要)
- **設定エラー防御**: yaml の構造不正・重複 id・非 https URL・非実在日付はビルド失敗 → 壊れた枠は本番に出ず、既存デプロイが残る(blocklist と同方針)
- **支援導線**: `src/lib/site.ts` の `supportUrl` が空の間は非表示。プラットフォーム開設後に URL を記入するだけでフッターに「このサイトを応援する」が出る

## 変更ファイル

- 新規: `data/sponsors.yaml`(空+記入例コメント), `src/lib/sponsors.ts`(検証・期限フィルタの純関数), `src/lib/site.ts`, `src/components/SponsorCard.astro`, `test/sponsors.test.ts`(9件)
- 変更: `src/components/HomePage.astro`(ビルド時読込+セクション追加), `src/layouts/Layout.astro`(支援リンク), `src/lib/i18n.ts`(6キー追加), `src/styles/global.css`

## 検証

テスト 63/63 パス(sponsors 9件含む)・`npm run check` 0 errors・ビルド日英2ページ生成。ビルド保護3ケース(YAML 構文エラー / 数値 until / ファイル欠落)すべて非0終了を確認し原状回復。実ブラウザ(chrome-devtools)で ja/en × 0件/ダミー1件 × 375px/1280px を確認 — PR バッジは `--accent-deep`(コントラスト規則遵守)、locale 別説明文の切替、リンク属性、横スクロールなし。ダミーと仮 supportUrl は復元済み。

## 運用メモ

- 掲載開始: `data/sponsors.yaml` の `[]` を消してエントリを記入(ファイル内コメントに記入例)。コミット→push で反映
- 掲載終了: `until` 到来で自動。即時に消したい場合はエントリ削除して push
- 金額・規約は DM で個別案内(コード外)。本格化して収益が「主」になりそうなら GitHub Pages 規約の観点で Cloudflare Pages 移行(`_doc/temp/202608112220_ドメイン議論まとめ.md` §2)とセットで再検討

## ユーザーに確認したい事項

- 募集カードの文言「コミュニティ活動やサービスの掲載を募集しています。お気軽にご相談ください。」(en: "We welcome community activities and services. Get in touch to learn more.")はこのままでよいですか？(修正は `src/lib/i18n.ts` の該当キーを直すだけ)
- セクション位置はページ下部(「今後の配信」の後)で開始しています。目立たせたい場合は LIVE/TODAY 間への引き上げも可能です
- 支援プラットフォーム(Ko-fi 等)を開設したら URL をお知らせください。`src/lib/site.ts` に記入して即反映できます
