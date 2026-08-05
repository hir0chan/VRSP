# Twitch 対応(NOW ON LIVE への Twitch ライブ統合) 実装計画書

日付: 2026-08-05_15:58
種別: 計画型
状態: **実装完了**(2026-08-05)
担当: コーディング codex / レビュー・検証 Claude

## 1. 背景・目的

ユーザー承認済みの Twitch 対応に着手する。Twitch はカテゴリ(VRChat)指定でライブを正確に取得できるため、**NOW ON LIVE の充実**が主目的。Twitch には「カテゴリ横断の配信予定 API」が存在しないため、**今後の配信(upcoming)は対象外**(YouTube 専任)とする。

事前調査(2026-08-05 実測):
- Client Credentials フローでトークン取得成功(有効期限 ≈57日。ただし毎回取得する設計とし、保存・更新管理はしない)
- **VRChat カテゴリ ID = `499003`**(Get Games で検証済み)
- ライブ数は1ページ(100件)超・日本語は少数。**成人向けフラグ(`is_mature`)付きが相当数**存在する

## 3. 確定仕様

(§2 系はテンプレート上の提案型専用セクションのため省略)

| 項目 | 決定内容 |
|---|---|
| 取得範囲 | **live のみ**(Get Streams `game_id=499003`)。upcoming / ended は取得しない(理由: §1。Twitch の VOD 取得は将来課題) |
| 認証 | App Access Token を **update 実行のたびに取得**(POST id.twitch.tv/oauth2/token、client_credentials)。トークンの保存・失効管理はしない(1リクエスト増で状態管理ゼロの最も単純な構成)。認証情報は env `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`(.env / GitHub Secrets)。**env 欠落時は Twitch 取得を warn してスキップ**(YouTube のみで動作継続。モックモード時は Twitch も内蔵モックで生成) |
| リクエスト仕様 | Get Streams: `Client-Id` + `Authorization: Bearer <app token>` ヘッダー、`game_id=499003&first=100`、2ページ目以降は `after=<cursor>`。**2系統のクエリを実行**: ①通常取得(最大 **3ページ/300件**)②**`language=ja` 付き専用クエリ(最大1ページ/100件)** — ①の300件圏外に沈む低視聴者数の日本語配信を取りこぼさないため(日本語ライブが100件を超えた場合は先頭100件で打ち切り＝実測3件に対し十分な余裕)。**両系統の結果は `stream.id` で重複排除**(ページ取得中の順序変動対策も兼ねる)。**2系統のうちいずれかのクエリ/ページが失敗した場合は Twitch 全体を失敗扱い**とする(部分採用しない。「ja 取りこぼし防止」を確定仕様として保つ最も単純な規則)。トークン取得・Get Streams とも **15秒タイムアウト**(AbortSignal.timeout。タイムアウトも Twitch 失敗として扱う)。リクエスト数は**最大5/回**(トークン1+通常3+ja1)。レスポンスは unknown から型ガードで検証(any 禁止)。**個別 item の必須フィールド不正は warn してその item のみ除外**、トップレベル構造不正はクエリ失敗。**エラーメッセージに client_secret / access_token を含めない**(既存 youtube.ts の REDACTED 方式を踏襲し、テストでも秘密値が漏れないことを検証) |
| 成人向け除外 | **`is_mature === true` の配信は除外する**(サイトのトーンとブランド安全性のため。実測で相当数が該当)。※ユーザー判断で変更可能なよう定数 `EXCLUDE_MATURE = true` で実装 |
| 表示件数の選抜式 | mature 除外・重複排除後の集合を eligible とし、**`dedupeById(eligibleJa ∪ take(sortByViewersDesc(eligibleNonJa), 50))`** を採用(= **ja は ja 専用クエリで取得した最大100件のすべて、非 ja は viewer_count 降順で最大50件**。50件枠は非 ja のみに適用)。同 viewer 数のタイブレークは `id` 昇順で安定化(テスト対象)。定数 `MAX_TWITCH_LIVE = 50` |
| データモデル | `Stream.platform?: "youtube" \| "twitch"`(optional。**欠落 = youtube** として後方互換)。Twitch 由来の値: `id = "tw-" + stream.id` / `streamerId = "tw-" + user_id` / `title` / `thumbnail = thumbnail_url の {width}x{height} を 640x360 に置換` / `url = "https://www.twitch.tv/" + user_login` / `status = "live"` / `actualStart = started_at` / `viewers = viewer_count` / `isJapanese = (language === "ja")`(かなヒューリスティック不使用。API の言語フィールドが正) |
| Streamer 生成・整合性 | Twitch の stream と streamer(`id = youtubeChannelId = "tw-" + user_id`、`name = user_name`。フィールド名の流用はモデルコメントで明記)は**対で変換**し、streamer は既存の `buildStreamers` 相当のマージに **YouTube 分と併せて渡す**。既存の参照整合性検証(update.ts の「streams の全 streamerId が streamers に存在」チェック)は **Twitch 分を含む最終 streams に対して**実行する。モックにも Twitch stream と対応する Streamer を対で追加 |
| tracked との関係 | Twitch ライブは**追跡集合(tracked)に入れない**。毎回全量取得で完結するため(YouTube の tracked / discovery.json の仕組みには一切触れない)。streams.json の `streams`(表示用)にのみマージする。`tracked` は YouTube 専用のまま |
| 制御フローへの統合位置 | Twitch 取得は **runUpdate 内で YouTube パイプラインと独立に、早期 return より前に実行**する(モード判定直後)。各書込経路との関係を明定義: ①YouTube 通常書込 → streams に Twitch 分をマージ ②追跡0 + discovery 全成功0件の空書込 → Twitch 分があれば streams = Twitch のみで書込 ③**追跡0 + クールダウン中(従来は無書込)→ Twitch 取得が成功していれば Twitch 分のみで書込**、Twitch 未設定/失敗なら従来どおり成功扱いの無書込 ④YouTube 全 refresh 失敗 → 従来どおり**書き込まず非0終了**(既存データ保護が最優先。Twitch 分もこの回は反映しない) |
| 失敗時挙動 | Twitch 取得失敗(トークン・API・タイムアウト)は **warn してスキップし、その回は Twitch 分なしで書込**(前回分の引き継ぎはしない — live は鮮度が命であり、停止した配信を live 表示し続ける方が有害。15分後の次回実行で自己回復)。**Twitch の失敗は YouTube 側の書込可否に影響させない**(逆も④のとおり) |
| UI | StreamCard に**プラットフォーム表示チップ**を追加: サムネイル左下に小さく「Twitch」(twitch 由来のみ表示。YouTube はチップなし=現状維持で情報過多を回避)。チップは既存トークンで(--surface 地 + --ink-soft 文字、時刻チップと同型)。**ブランドカラー(紫)は使わない**(アクセント赤のみの規律維持)。カードの `aria-label` は現在「〜をYouTubeで見る」固定のため、**プラットフォーム共通の「〜の配信ページを見る」に変更**。card-action 文言「配信ページへ」は共通のため不変 |
| サムネ変換の検証 | `thumbnail_url` に `{width}` と `{height}` の両プレースホルダが存在することを検証して 640x360 に置換。欠落・置換後に残存する場合はその item を warn して除外。`viewer_count` が有限・0以上の整数でない item は **warn して除外**(非 ja の上位50選抜のソートキーであり省略では順序を定義できないため。YouTube 由来の viewers が optional であることとは区別する) |
| 「日本語のみ」トグル | そのまま機能する(twitch 由来は API の language で isJapanese 設定済みのため追加実装不要) |
| CI | update.yml の update ステップ env に `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` を追加(Secrets は Claude が gh で登録) |
| ドキュメント | README の仕組み・注釈(「YouTube のみ」前提の記述)を更新。CLAUDE.md のアーキテクチャ節を同期 |

### 成立性の根拠(調査済み)

- 実クレデンシャルでトークン取得 → Get Games → Get Streams(100件)まで疎通済み(2026-08-05)
- カテゴリ ID 499003 は Get Games の実レスポンスで確認
- is_mature・language・viewer_count・thumbnail_url テンプレート・pagination cursor はすべて実レスポンスで存在確認済み

## 4. 実装設計

### 4.1 変更ファイル

```
scripts/
├── twitch.ts    # 新規: fetchAppToken / fetchVrchatLiveStreams(通常最大3ページ + ja専用1ページ
│                #   の2系統・id 重複排除・いずれか失敗で全体失敗)
│                #   変換・is_mature 除外・上限選抜は純関数に分離(fetchFn 注入でテスト)
├── models.ts    # Stream.platform?: "youtube" | "twitch" 追加(+フィールド流用のコメント)
├── update.ts    # Twitch 取得の組込み(YouTube パイプラインと独立に実行し書込前にマージ)、
│                #   isStream に platform の検証追加(欠落許容・不正値拒否)
└── mock.ts      # モックに Twitch 由来相当(platform: "twitch")を2件追加
src/components/StreamCard.astro  # プラットフォームチップ(twitch のみ)
src/styles/global.css            # チップのスタイル
.github/workflows/update.yml     # env 2件追加
test/twitch.test.ts              # 新規
README.md / CLAUDE.md
```

### 4.2 変更しないもの

- YouTube 収集パイプライン(youtube.ts・discovery.json・tracked・クールダウン)・classify.ts・thumbnail.ts(Twitch サムネは絶対 URL なので既存関数で解決)・blocklist(YouTube チャンネル用のまま。Twitch 用除外は必要になったら別途)

## 5. 検証計画

1. **単体テスト**(モック fetch): トークン取得(失敗時の型・**エラー文字列に secret/token が含まれないこと**)/ ページング(cursor 3ページ・空 cursor 停止・**2系統クエリの id 重複排除**)/ is_mature 除外 / 選抜式(ja 全件 ∪ 非 ja viewer 降順50件・**同 viewer の id タイブレーク**)/ Stream 変換(サムネ置換・プレースホルダ欠落 item の除外・**viewer_count 不正 item の除外**・isJapanese・platform)/ **個別 item 不正は warn 除外でクエリは成功扱い** / env 欠落時のスキップ / タイムアウトの失敗扱い / **制御フロー4経路**(YouTube 通常+Twitch マージ / 追跡0+discovery成功0件+Twitch あり / 追跡0+クールダウン+Twitch 成功で書込・失敗で無書込 / YouTube 全滅時は Twitch があっても非0終了・既存不変)/ **Twitch streamer を含む参照整合性** / isStream の platform 後方互換
2. **型・ビルド**: `npm run check` 0 errors / `npm run build` 成功
3. **実データ**: `npm run update` → streams.json に platform: "twitch" のライブが入り、is_mature 除外・件数上限が効いていること → dev サーバーで Twitch チップ表示・「日本語のみ」トグルとの整合・カードリンク先(twitch.tv)を確認
4. **本番**: Secrets 登録 → push → CI 成功 → 本番で Twitch ライブ表示確認
5. **クォータ**: YouTube への影響ゼロ(別 API)。Twitch は**最大5リクエスト/回** × 96回/日 ≈ 480 — レート制限(毎分800pt)に対し無風

## 6. 影響範囲・リスク

- NOW ON LIVE の件数が大幅に増える(現状 YouTube 20〜30 + Twitch 最大50+ja)。ページが縦に長くなるが、まず実物を見て判断(セクション内の折りたたみ等は次段の改善候補)
- is_mature は配信者の自己申告のため、未申告の成人向けコンテンツは漏れ得る(発見次第 blocklist 系の対応を別途)
- viewer_count 上位選抜は英語圏大手に偏りやすい(ja 全件別枠でメインターゲットは保護)
- トークンを毎回取得するため id.twitch.tv 障害時はその回の Twitch 分が欠ける(自己回復)

## 7. 未決事項(デフォルト採用・変更可)

- `EXCLUDE_MATURE = true` / `MAX_TWITCH_LIVE = 50` はデフォルト値(ユーザー判断で変更可)
- Twitch チップの表記は「Twitch」テキスト(アイコン化は将来)
- Twitch の ended(VOD)対応・Twitch 用ブロックリストは将来課題

## 8. 実施結果

- §3 の確定仕様に従い、Twitch の認証・2系統取得・検証・選抜・変換と update 制御フロー4経路を実装した
- Twitch の stream / streamer 対、モック2件、UIチップ、CI env、README / CLAUDE.md / `.env.example` を同期した
- `npm run check`: 成功(0 errors / 0 warnings)
- `npm test`: tsx IPC ソケット制約で起動できなかったため、指定の代替 `node --import tsx --test test/*.test.ts` を実行し 43/43 成功
- `npm run build`: 成功
- モックモード update: tsx IPC ソケット制約のため `YOUTUBE_API_KEY= node --import tsx scripts/update.ts` で実行し成功。Twitch 表示2件、tracked 0件、参照整合性を確認
- 生成HTMLで Twitch チップ2件、共通 aria-label、旧YouTube固定 aria-label の不在を確認
- 実データ確認で判明した自己申告漏れへの補強として、タイトルの明示的 NSFW マーカー(`🔞` / `+18` / `18+` / `nsfw` / `r-18` / `r18`)によるフォールバック除外と全パターンのテストを追加した
- 実 API と git 操作は実施していない。実装仕様からの逸脱はない
