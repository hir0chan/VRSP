# ニコニコ生放送対応 実装計画書(技術検討)

日付: 2026-08-06_01:08
種別: 提案型 → 計画型(2026-08-06 ユーザー合意「推奨で進行を」により §3 以降を追記)
状態: **実装・検証完了**(2026-08-06。文末「実施結果」を参照)
担当: 調査・検証 Claude / コーディング codex

## 1. 背景・目的

YouTube / Twitch に続き、ニコニコ生放送の VRChat 関連ライブ・配信予定も掲載できるかのユーザー打診。まず技術的可否と実現方式を検討する(実装は本書の合意後)。

## 2-1. 技術的可否

**結論: △ 条件付きで可能**(目的を満たす公式 API を公開資料上確認できず、非公式データ源への依存を許容できる場合に限る)

### 可否判断の根拠(調査結果。すべて 2026-08-06 に実測・確認)

1. **公式 API**: 公式公開 API「スナップショット検索 API v2」は**動画のみ**で生放送を含まない。OAuth ベースの公式 API プラットフォームは事業者向け申請制で、公開資料上、生放送の横断検索 API は確認できなかった。`live.nicovideo.jp/front/api/` 配下の検索エンドポイントも複数パターン試行したが全て 404(未発見であり不存在の証明ではない)
2. **検索ページの SSR JSON**(ニコニコ側でサーバーレンダリングされた HTML の意。本サイトを SSR 化するわけではない): `https://live.nicovideo.jp/search?keyword=VRChat&status=onair` の HTML 内 `<script id="embedded-data" data-props="...">` に検索結果 JSON が HTML エンティティエンコードで埋め込まれており、復号+パースで `title` / `description`(**末尾切り詰めあり**) / `listingThumbnail` / `watchPageUrl` / `nicoliveProgramId` / `beginTime`・`endTime`(unix秒) / `status`("ON_AIR" / "RELEASED") / `supplier`(配信者名・ID・アイコン) / `statistics.watchCount`(意味は要確認。累計来場者数の可能性) / `payment` / `isFollowerOnly` を確認した。タグ配列は結果内に見当たらない
3. **配信予定も取得可能**: `status=reserved` で予約番組が同じ構造(`status: "RELEASED"`、`beginTime` = 予定開始時刻)で取れることを確認
4. **アクセス許諾の状況**: 明示的な許諾は存在しない。確認できた事実は次のとおり——`live.nicovideo.jp/robots.txt`(2026-08-06 確認)は `User-Agent: * / Allow: /` で禁止指示なし(ただし robots.txt はクローラへの技術的指示であり法的許諾ではない)。ニコニコ利用規約(account.nicovideo.jp/rules/account、同日確認)の禁止事項に個別のスクレイピング禁止条項は見当たらず「ニコニコのサーバーに過度の負担を及ぼす行為」の禁止のみ。なお HTML 取得だけでなく、タイトル・配信者名・サムネイル URL の再掲載(サムネはホットリンクになる)も運用に含まれる点は YouTube / Twitch と同様の形態であり、**規約変更や権利者からの要請があれば掲載を停止する**運用を条件とする
5. **データ量**: 実測時点で VRChat キーワードの生放送 2件・予約 1件(totalCount 2、1ページで全量)。リクエストは15分毎に2本(=約192本/日+手動実行分)で「過度の負担」には該当しないと判断するが、429 等を受けた場合はリトライせずその回のニコ生分を省略する
6. **ブランド素材**: niconico はロゴ・シンボルマークをニコニ・コモンズおよびガイドライン PDF(site.nicovideo.jp/term/guideline/commons/logo/niconico/)で公式公開している。利用条件・改変可否・クレジット要否は**合意前に確認を完了させる**。確認の結果条件が合わない場合はテキストバッジ「ニコ生」を既定とする

### 必須の前提改修

なし(既存の Twitch 統合と同型のフェイルソフト構造に載る)

## 2-2. 実現方式の比較

### 案A: 検索ページ SSR JSON のパース(推奨)

15分毎の update で `status=onair` と `status=reserved` の2リクエストを発行し、HTML から `embedded-data` を抽出・復号・検証して表示用 `streams` に合流させる。

- ⭕ 追加依存ゼロ(fetch + 文字列抽出 + エンティティ復号 + JSON.parse + 型検証のみ)
- ⭕ ライブに加え配信予定も掲載できる(YouTube 以外で初)
- ⭕ 失敗時はその回のニコ生分を省略する縮退が Twitch と同型に組める
- ❌ **非公式のページ内部構造への依存**。ニコニコ側の改修で予告なく壊れる(壊れた場合はニコ生分が非表示になるだけでサイト全体は無事、という設計にする)
- ❌ 明示許諾がない(上記 §2-1-4 の運用条件つきで許容するかは合意事項)

#### 案A の処理契約(実装時に厳守)

- HTTP ステータス・Content-Type・タイムアウトを検証し、`embedded-data` が 0件/複数件のとき・エンティティ復号や JSON.parse が失敗したときは**「結果0件」と区別してエラー扱い**とし、警告ログの上でその回のニコ生分を省略する
- パース結果は `unknown` から各フィールドを型検証(strict TS・`any` 禁止)。不正な番組 item は個別に除外し、ルート構造の不正はページ全体の失敗とする
- onair / reserved の**どちらか一方でも失敗した場合はその回のニコ生全体を省略**する(半端な状態を出さない)
- ニコ生の失敗は YouTube / Twitch の取得・書込に影響させない。逆に YouTube 全滅時に本体を書き込まない既存挙動も変えない。ニコ生の Stream と Streamer は必ず同時に合流させ、既存の参照整合検査の対象に含める
- 追跡対象0件・discovery クールダウン中に Twitch 成功時のみ書き込む既存分岐(update.ts の `twitchSucceeded` 判定)は「**Twitch またはニコ生のいずれかが取得成功したらプラットフォーム成功**」に拡張する(Twitch 未設定/失敗でもニコ生成功なら書き込める)
- 実 HTML を fixture 化し、エンティティ復号・構造検証・構造変更時の縮退をテストする
- 1ページのみ取得し、`totalCount > 取得件数` を検出したら警告ログを出す(黙った切り捨てをしない)。恒常化したらページング追加を検討する

### 案B: 公式 OAuth API プラットフォームへの利用申請

- ⭕ 公式・安定
- ❌ 事業者向け申請制で個人ポータルが通る見込みが不明。かつ公開資料上、生放送の横断検索 API が確認できないため、承認されても目的を満たせない可能性が高い

### 案C: 見送り(現状維持)

- ⭕ リスクゼロ
- ❌ 実測ではニコ生の VRChat 配信は常時数件規模であり、掲載価値はあるが逸失は小さい——を許容することになる

**結論: 案A を条件付き推奨。** 必要フィールドの充足・負荷・実装量のバランスが良く、壊れた際の影響もニコ生分の欠落に限定できる。条件は §2-1-4 の運用合意と §2-3 の各論点の確定。

## 2-3. 実装前に確認したい点

1. **非公式依存と掲載形態の許容**: ①ページ構造変更でニコ生分が突然消える(直すまで非表示)リスク ②明示許諾なしでのタイトル・サムネ(ホットリンク)再掲載を、規約変更・要請時停止の運用条件つきで許容するか(推奨: 許容)
2. **採用フィルタ**: ニコ生検索はタイトル以外(説明文・タグと推定)にも一致するため、タイトルに VRChat を含まない番組も返る。(a) 検索結果をそのまま採用(推奨。ニコ生検索自体をフィルタとみなす。Twitch のカテゴリ採用と同型)/(b) YouTube と同じ「タイトルまたは説明文(切り詰めあり)に vrchat」で追加フィルタ——タグのみ一致の番組が落ちる仕様差に注意
3. **配信予定(reserved)の掲載**: 掲載する場合、既存 YouTube の「30日先まで」の表示窓に**ニコ生も合わせる**(推奨)。`RELEASED`→upcoming、`ON_AIR`→live に対応づけ、両リストに同一 lv ID が現れた場合は live を優先して重複排除。`beginTime` 欠落・不正値の番組は除外
4. **除外方針**: `payment: true`(有料)と `isFollowerOnly: true`(フォロワー限定)は除外を推奨(視聴導線にならない)。掲載してバッジ表示する代案もあり
5. **日本語判定**: ニコ生はほぼ日本語圏のため `isJapanese: true` 固定を推奨(=「日本語のみ」フィルタで常に表示)。厳密にするならタイトルのかな判定(`isJapaneseContent`)の流用も可
6. **モデレーション**: 成人向け番組は、①検索結果に判定可能なフラグがあればそれで除外、②フラグがない場合は既存 Twitch のタイトルパターン除外を流用し、それでも判定できない番組は掲載(事後は blocklist で対処)——の二段構えとする(Twitch と同方針。なおニコ生の R18 番組はログイン必須のため未ログイン取得の検索結果には現れない可能性が高く、実装時に実測で確認する)。既存 blocklist はニコ生 supplier ID にも適用する(`Streamer.youtubeChannelId` 互換フィールドへ Twitch 同様に格納。ID 衝突防止の接頭辞設計は実装時に確定)
7. **viewers の扱い**: `watchCount` は累計来場者数の可能性があるため、意味を確認できるまで `viewers` には**格納しない**(推奨)

## 3. 確定仕様(2026-08-06 ユーザー合意: §2-3 の全推奨案を採用)

| 項目 | 決定内容 |
|---|---|
| データ源 | `https://live.nicovideo.jp/search?keyword=VRChat&status=onair` と `status=reserved` の2リクエスト/回。UA は一般ブラウザ相当を明示。タイムアウト 15秒(Twitch と同値)。429 等の失敗時はリトライせずその回のニコ生分を省略 |
| 採用範囲 | 検索結果をそのまま採用(ニコ生検索自体をフィルタとみなす。タイトル/説明文の vrchat 追加フィルタはしない) |
| 除外 | `payment: true`・`isFollowerOnly: true`・成人向け判定フィールドが実測で見つかった場合はそれによる除外(2026-08-06 実測では onair 結果に該当フィールドなし。実装時に reserved 含め再確認し、存在すれば型検証+除外+テストを追加)・タイトルが既存 `NSFW_TITLE_PATTERNS`(twitch.ts から共通化 or 複製)に一致・blocklist の channelId が `nico-{supplierId}` に一致する番組。blocklist は `convertPrograms` に `blockedIds: Set<string>` として渡し、Stream と対応 Streamer を合流前に一緒に除外する |
| ID 規約 | Stream.id = `nico-{nicoliveProgramId}`、streamerId = `nico-{programProviderId}`(Twitch の `tw-` 接頭辞と同型。`youtubeChannelId` 互換フィールドにも同値を格納) |
| status 対応 | `ON_AIR` → live(`actualStart` = beginTime)、`RELEASED` → upcoming(`scheduledStart` = beginTime)。それ以外の status と `beginTime` 欠落・非整数・範囲外は番組単位で除外。onair / reserved 両方に同一 lv ID が現れたら live を優先 |
| 表示窓 | upcoming は既存 YouTube と同じ「30日先まで」に制限(update.ts 合流前にフィルタ)。追跡集合 `tracked` には入れない(毎回全量再取得、Twitch と同型) |
| isJapanese / viewers | `isJapanese: true` 固定。`viewers` は格納しない(watchCount の意味が未確定のため) |
| フェイルソフト | §2-2「案A の処理契約」のとおり。update.ts の追跡0件+クールダウン分岐は「Twitch **または**ニコ生の成功」で書き込みに進む形へ拡張 |
| UI | サムネ左下チップ: テキスト「ニコ生」(公式ロゴはガイドライン上「自身の創作活動の告知」向け公開素材で第三者ポータル利用の可否が判然としないため見送り。確認でき次第切替可)。フィルタセグメントに「ニコ生」を追加(テキストのみ)。localStorage `vrsp-platform` の許容値に `"niconico"` 追加 |
| モック | `YOUTUBE_API_KEY` 未設定時にニコ生架空データ(live 2件・upcoming 1件)を生成。実データモードではニコ生は認証不要のため常に取得を試みる |
| 変更しないもの | YouTube / Twitch の取得ロジック・discovery・追跡上限・分類ロジック(classify.ts)・サムネ解決(thumbnail.ts)・CI ワークフロー定義 |

## 4. 実装設計

- `scripts/niconico.ts` **新規**: `fetchVrchatNiconicoStreams(blockedIds, fetchFn?)` を公開。内部は純関数分離——`extractEmbeddedData(html): unknown`(`embedded-data` の一意抽出+エンティティ復号+JSON.parse。0件/複数件/復号失敗は throw)、`parseProgram(value, index): NiconicoProgram | undefined`(型検証。不正 item は warn してスキップ)、`convertPrograms(onair, reserved, now, blockedIds): { streams, streamers }`(除外・重複排除・30日窓・ISO 変換。blocklist 一致は Stream と対応 Streamer を一緒に除外)。twitch.ts の `parseItem` / `convertItems` / `redactedMessage` の構成に倣う
- `scripts/models.ts`: `platform?: "youtube" | "twitch" | "niconico"`
- `scripts/update.ts`: isStream 型ガードの platform 判定に `"niconico"` 追加。`niconico` 取得(失敗 warn)+`platformSucceeded = twitchSucceeded || niconicoSucceeded` への分岐変更。3箇所の書込パスすべてで twitch と同様に streams / streamers を合流し `assertReferences` の対象に含める
- `scripts/mock.ts`: `generateMockNiconicoStreams(now)` 追加(純関数)
- `src/components/StreamCard.astro`: `platform === "niconico"` でテキストチップ「ニコ生」(既存 `.platform-chip` にテキスト表示の分岐を追加)
- `src/pages/index.astro`: セグメントに `platform-niconico` radio + label「ニコ生」追加
- `src/layouts/Layout.astro`: head 復元と change 処理の許容値に `"niconico"` 追加(2箇所)
- `src/styles/global.css`: カード表示制御に niconico の組を追加、空グループ非表示ルールを ja-only × platform 4値 = **8状態の列挙**に拡張
- `test/niconico.test.ts` **新規** + `test/fixtures/nicolive_search.html`(実 HTML を fixture 化): 抽出・復号・型検証・変換・除外・重複排除・30日窓・構造変更時の throw を検証

## 5. 検証計画

1. **正常系**: `npm test`(新規含む全パス)・`npm run check` 0 errors・`npm run build` 成功。`YOUTUBE_API_KEY= npx tsx scripts/update.ts` でモックにニコ生分が含まれること。実データモードで `scripts/update.ts` を手動実行し、実ニコ生番組(実測で live 2件程度)が streams.json に入ること
2. **異常系**: fixture を壊した HTML(embedded-data なし/複数/不正 JSON)で「結果0件」と区別してエラーになりニコ生分が省略されること。HTTP 429・Content-Type 不正・タイムアウトの各失敗で throw すること(fetchFn モックで注入)。onair 成功+reserved 失敗でニコ生全体が省略されること
3. **境界**: beginTime 欠落・非整数番組の除外。31日先の reserved の除外。onair/reserved 重複 lv ID の live 優先。totalCount > 件数時の警告ログ。blocklist 一致番組の Stream / Streamer 同時除外
4. **update.ts 統合(3書込経路。fetchFn モックで Twitch なし構成にして確認)**: ①通常経路(YouTube refresh 成功)でニコ生 Stream / Streamer が合流すること ②追跡0件+discovery クールダウン中でもニコ生成功なら書き込むこと ③追跡0件+discovery 実行の経路で合流すること ④YouTube 全 refresh 失敗時はニコ生成功でも既存ファイルが変更されないこと ⑤各経路で assertReferences が満たされること
5. **回帰**: YouTube / Twitch のみの既存テストが全パス。dev サーバーでフィルタ(ニコ生セグメント・日本語のみ併用・空グループ)動作確認。ニコ生取得失敗をシミュレートしても YouTube / Twitch 分が書き込まれること

## 6. 影響範囲・リスク

- scripts 層は追加中心(update.ts の成功判定分岐のみ変更)。表示層はフィルタ拡張のみ。CI 定義は無変更(ニコ生は認証不要のため Secrets 追加なし)
- ニコ生のページ構造変更で取得が壊れるリスク(設計上ニコ生分の欠落に留まる)。壊れた際は警告ログを CI ログで確認できる
- 空グループ CSS が8状態列挙になり保守性がやや低下(プラットフォーム追加のたびに倍増する構造的限界は認識の上、3プラットフォームまでは列挙で許容)

## 8. 改修規模の見積

| 項目 | 内容 | 目安 |
|---|---|---|
| 取得スクリプト | `scripts/niconico.ts` 新規(fetch・抽出・復号・型検証・変換・除外)+ update.ts 統合 | 0.5日 |
| データモデル | `platform` union に `"niconico"` 追加 | 0.1日 |
| 表示層 | サムネアイコン・フィルタセグメント追加に加え、localStorage 許容値判定(Layout.astro 2箇所)・空グループ非表示 CSS の状態組合せ拡張(ja-only × プラットフォーム4値 = 8状態)も対象 | 0.4日 |
| モック・テスト | mock.ts へのニコ生架空データ、fixture ベースのパーサテスト、変換・除外の単体テスト | 0.4日 |

## 9. 実施結果(2026-08-06 実装・検証完了)

### 実装

§3・§4 のとおり実装(コーディング codex / レビュー・検証 Claude)。計画との差分は2点のみ: ①UA は「一般ブラウザ相当」ではなく素性を明示する bot UA(`Mozilla/5.0 (compatible; VRSP/1.0; +リポジトリURL)`)を採用(実通信で問題ないことを確認済み)②レビュー指摘により、変換で未使用だった supplier アイコン URL の必須検証を撤廃(アイコン未設定配信者の番組を不必要に弾かないため)。

- 新規: `scripts/niconico.ts`(抽出・復号・型検証・変換・除外を純関数分離)、`test/niconico.test.ts`、`test/fixtures/nicolive_search_{onair,reserved}.html`(実 HTML を匿名化して fixture 化)
- 変更: `scripts/models.ts` / `scripts/update.ts`(3書込経路への合流・`platformSucceeded` 拡張)/ `scripts/mock.ts` / `src/components/StreamCard.astro` / `src/pages/index.astro` / `src/layouts/Layout.astro` / `src/styles/global.css`(8状態列挙)/ 既存テスト2件の追随

### 検証結果

| 検証 | 結果 |
|---|---|
| `npm run check` / `npm test` / `npm run build` | ✅ 0 errors・53件全パス・成功 |
| モックモード(`YOUTUBE_API_KEY=` で update) | ✅ ニコ生 live 2件+upcoming 1件が生成 |
| 実データモード(`npm run update`) | ✅ 実ニコ生 live 2件+upcoming 1件を取得(YouTube 89・Twitch 55 と共存)。実装 UA での実通信成功 |
| 異常系・境界(fixture 破壊・HTTP 429/Content-Type/タイムアウト・片側失敗・beginTime 不正・31日先・重複 lv・blocklist) | ✅ test/niconico.test.ts 9件で網羅 |
| update.ts 3書込経路の統合 | ✅ 既存 youtube.test.ts のクールダウン分岐テスト追随含め全パス |
| ブラウザ(実データ) | ✅ 「ニコ生」チップ表示・セグメント切替(ニコ生選択で YT/TW 0件)・日本語のみ併用・localStorage 復元 |
| fixture 匿名化 | ✅ 実在の配信者名・番組名・ID の残存なしを grep で確認 |

### 残課題・補足

- 公式ロゴは利用条件が確認でき次第テキストバッジから切替可(§3 のとおり)
- ニコ生のページ構造変更で取得が壊れた場合は CI ログに警告が出てニコ生分のみ非表示になる
