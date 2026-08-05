# Twitch 対応(NOW ON LIVE への Twitch ライブ統合) 実装レポート

日付: 2026-08-05
対象計画書: `202608051558_twitch_support.md`

## 実装内容

- `scripts/twitch.ts` を追加し、実行毎の App Access Token 取得、15秒タイムアウト、通常最大3ページと日本語専用1ページの Get Streams、全体失敗規則、秘密値の非露出を実装
- unknown レスポンスを型検証し、個別不正 item を警告除外。成人向け除外、サムネイル変換、viewer_count 検証、ID重複排除を実装
- 日本語全件と非日本語の視聴者数上位50件を選抜し、同数時はID昇順で安定化
- Twitch の Stream / Streamer を対で生成し、`Stream.platform` と update の最終参照整合性検証を追加
- Twitch を YouTube の tracked / discovery から分離し、通常、追跡0・発見成功0件、追跡0・クールダウン、全refresh失敗の4経路へ統合
- モックに Twitch の stream / streamer 対を2件追加し、表示用 streams のみに格納
- StreamCard に Twitch のみの左下チップを既存配色で追加し、aria-label をプラットフォーム共通文言へ変更
- GitHub Actions、README、CLAUDE.md、`.env.example` を Twitch 対応へ同期
- `test/twitch.test.ts` に計画書 §5-1 の取得、検証、選抜、変換、失敗、4経路、参照整合性、後方互換テストを追加。ファイル冒頭で console 3種を no-op 化

## 検証結果

- `npm run check`: 成功、Astro/TypeScript 0 errors・0 warnings
- `npm test`: tsx の IPC ソケット作成が `EPERM` となったため、指定の代替 `node --import tsx --test test/*.test.ts` を実行。43/43 成功
- `npm run build`: 成功、静的ページ1件を生成
- `YOUTUBE_API_KEY= node --import tsx scripts/update.ts`: 実 API を使わずモックモードで成功
- モック生成結果: Twitch 表示2件、Twitch tracked 0件、全 Twitch stream の streamer 参照が有効
- モック生成後のビルドHTML: Twitch チップ2件、共通 aria-label、旧YouTube固定 aria-label の不在を確認
- 実 API と git 操作は実施していない

## 計画からの逸脱

- 実行環境の tsx IPC ソケット制約により、テストとモック update は Node の `--import tsx` を使う同等コマンドで検証した。実装仕様からの逸脱はない
- ローカル認証設定を明確にするため、計画書の変更一覧に明記されていなかった `.env.example` も同期した

## ご確認いただきたい事項

- なし
