# コンテンツ起点収集への転換 実装レポート

日付: 2026-08-01
対象計画書: `202607312257_content_first_collection.md` 第4版

## 実装内容

- `scripts/youtube.ts`: `search.list(part=id)` の live / upcoming / completed 3クエリによる発見、`videos.list` 50件バッチによる動画単位 refresh、title/description の VRChat 判定、動画 snippet からのチャンネル情報生成
- `scripts/update.ts`: `discovery.json` の60分クールダウンと原子的即時書込、旧 streams から tracked への初回移行、除去規則6条、非 live 300件上限、表示窓生成、部分失敗引き継ぎ、空書込3分岐、streamers 2世代継承と先行 rename、blocklist 検証
- `scripts/mock.ts`: `streamers.yaml` に依存しない内蔵架空チャンネルへ移行。`data/streamers.yaml` を削除し `data/blocklist.yaml` を追加
- `.github/workflows/update.yml`: update を `continue-on-error` で実行し、`data/generated` のコミット後に update 結果を判定。失敗時は build/deploy 前に停止
- `README.md` と `CLAUDE.md`: コンテンツ起点のアーキテクチャ、配信者登録不要、blocklist 運用へ更新
- `test/youtube.test.ts` と `test/mock.test.ts`: 計画書 §5-1 の状態遷移・異常系・移行・不変条件を固定時刻とモック fetch で検証

## 検証結果

- `npm run check`: 成功、Astro/TypeScript 0 errors・0 warnings
- `npm test`: tsx の IPC ソケット作成が `EPERM` となったため、指定の代替 `node --import tsx --test test/*.test.ts` を実行。28/28 成功
- `npm run build`: 成功、静的ページ1件を生成
- `npm run update`: 同じ tsx IPC 制約のため、`YOUTUBE_API_KEY` を空に固定して `node --import tsx scripts/update.ts` を実行。モックモード成功
- 生成結果: tracked 11件、表示 streams 11件、streamers 5件。tracked の全 streamerId が streamers に存在することを確認
- 既存の classify/thumbnail テストは変更せず全件成功

## 計画からの逸脱

- 実行環境の tsx IPC ソケット制約により、`npm test` と `npm run update` は Node の `--import tsx` を使う同等コマンドで検証した。実装仕様からの逸脱はない
- 指示に従い実 API 実行、Google Cloud Console でのクォータ実測、git 操作、本番確認は実施していない

## ご確認いただきたい事項

- フッターの「掲載希望」文言は計画書どおり変更していない。自動掲載方式との整合を取る場合は別途文言変更が必要

## Claude 検証結果(2026-08-01 追記)

- npm test 29/29 / check 0 errors / build 成功
- 実データ検証(--discover): **追跡103件(live 30 / upcoming 38 / ended 35)・streamers 95件を自動生成**。全カード表示・画像切れなし。直後の引数なし update でクールダウンによる search スキップを確認
- レビュー修正2件: ①実 API で発見 — search.list が稀に id.videoId を欠く item を返し、1件の不正 item がクエリ全体を失敗させていた → 不正 item はスキップ+warn に変更(codex 修正)②その修正時のテストの構文エラー(閉じ括弧欠落)→ Claude が直接修正

## ご確認いただきたい事項(追記)

- **収集範囲は全世界**になりました(スペイン語圏等の VRChat 配信も掲載されます)。日本語圏に絞りたい場合は言語フィルタを別途計画します
- フッターの「掲載をご希望の方は…」文言は自動掲載制となった現状と少しずれています。文言変更のご希望があればお知らせください
- 不適切なチャンネルを見つけた場合は `data/blocklist.yaml` に channelId を1行追加で除外できます(私に依頼いただいても即対応します)
