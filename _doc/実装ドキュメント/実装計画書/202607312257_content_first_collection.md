# コンテンツ起点収集への転換(配信者リスト廃止) 実装計画書

日付: 2026-07-31_22:57
種別: 計画型
状態: **実装完了**(第4版で 2026-08-01 codex レビュークリア、同日実装・検証完了)
担当: コーディング codex / レビュー・検証 Claude

## 1. 背景・目的

現行の収集は「配信者リスト(streamers.yaml 30名)ありき」。ユーザーの指摘するデメリット(①配信者の洗い出しが前提 ②リスト保守が必要 ③VRChat と無関係な配信も掲載)を解消するため、**「VRChat を扱った配信かどうか」を直接問うコンテンツ起点の収集**に転換する(ユーザー承認済み・案B)。判定基準はユーザー指定のとおり「**タイトルまたは説明文に VRChat を含む**」。

## 3. 確定仕様

(§2 系はテンプレート上の提案型専用セクションのため省略)

### 3.1 収集の二層構成

| 項目 | 決定内容 |
|---|---|
| 発見(discovery) | `search.list` × 3クエリ: `part=id, q=VRChat, type=video, eventType=live / upcoming / completed, maxResults=50, relevanceLanguage=ja, order=date`。**約1時間毎**(下記クールダウン)。`id.videoId` の構造検証を行う |
| 状態更新(refresh) | **追跡集合**(下記)の全動画 ID を `videos.list`(part=snippet,liveStreamingDetails、50件バッチ、1unit)で毎回再取得。状態・視聴者数・チャンネル情報を更新 |
| 発見のクールダウン | クールダウン状態は streams.json ではなく**専用状態ファイル `data/generated/discovery.json`**(`{discoveryAttemptedAt, discoveredAt?}`)に持つ。`now - discoveryAttemptedAt >= 60分` の場合のみ発見を実施し、**発見を試行したら成否にかかわらず・かつ本体データの書込可否と無関係に**、この状態ファイルだけを即座に原子的に書き込む(refresh 全滅で本体が書けない場合や追跡0+discovery失敗で非0終了する場合でも試行時刻は必ず残る)。**CI をまたいだ永続化**: update.yml を変更し、update ステップを `continue-on-error` で実行 → generated のコミットステップ(discovery.json を含む)を先に通し → **update が失敗していた場合はその後のステップでジョブを失敗させる**(ビルド・デプロイには進まない)。これによりランナー破棄で試行時刻が消えて次回 cron が再検索する穴を塞ぎ、**自動実行の発見は最大24回/日を構造的に保証**。`discoveredAt` は **3クエリ全成功時のみ**更新(部分成功では更新しない)。**不正な日時・未来日時は期限切れ扱い**(=発見を実施)。CLI 引数 `--discover` は**ローカル手動専用**(workflow_dispatch は引数なしの通常実行で、クールダウンに従う) |
| search の明示的制約 | `order=date` は**動画の公開日時順**であり、各クエリは「直近に公開された VRChat 該当動画の上位50件」しか見えない。ページングはしない(クォータ優先)。**作成から時間の経った予約枠や、50件圏外に沈んだ動画は発見できないことを仕様として受容**する(一度発見すれば追跡集合に入るため、以降の状態変化は refresh で追随できる)。completed クエリは「終了時刻順」ではないため保険としての効果は限定的(リスク欄参照) |

### 3.2 追跡集合(tracked)と表示(streams)の分離

| 項目 | 決定内容 |
|---|---|
| generated スキーマ | streams.json: `{updatedAt, tracked: Stream[], streams: Stream[]}`。**tracked = 追跡中の全配信**(表示窓外の未来 upcoming を含む)、**streams = tracked から表示窓で絞った表示用ビュー**(現行の streams と同義。UI はこれだけを読む)。発見状態は別ファイル `discovery.json`(§3.1) |
| 追跡集合の上限 | **`MAX_TRACKED = 300`**(非 live 分に適用)。**上限適用は refresh 後**(状態・日時が判明してから): ①ended の古い順 ②upcoming の `scheduledStart` が遠い順 に削って「非 live ≤ 300」に収める。live は削らない(live だけで300超は現実的に想定しないが、その場合 tracked は一時的に 300+live件 となることを許容)。refresh 対象は「前回 tracked(非live ≤300 + live ≤50 = ≤350)∪ 今回発見分(≤150)」= 発見回で最大500件 = **10unit** |
| 追跡集合の維持 | 次回 refresh 対象 = 前回 `tracked` の全 ID ∪ 今回発見分。これにより「30日より先の upcoming が発見直後に消えて追跡不能になる」問題を解消する |
| tracked からの除去規則 | ①API レスポンスから消えた(削除・非公開)②ended かつ `actualEnd < now-24h` ③upcoming のまま `scheduledStart < now-7d`(配信されず放置)④liveStreamingDetails なし ⑤VRChat 判定不一致 ⑥blocklist 該当。upcoming の `scheduledStart` が未来である限り期限で消さない |
| 表示窓(streams) | 現行踏襲: live は常に、ended は `actualEnd >= now-24h`、upcoming は `now-7d <= scheduledStart <= now+30d`(境界含む) |
| 初回移行 | 初回実行時は前回 streams.json に `tracked` が無いため、**旧 `streams` 配列を初期追跡集合として読む**(既存掲載中の配信を失わない)。旧データの独自 streamerId(zasan 等)は下記 streamers 継承により表示が壊れない |

### 3.3 VRChat 判定・チャンネル情報・ブロックリスト

| 項目 | 決定内容 |
|---|---|
| VRChat 判定 | `videos.list` の snippet に基づき **title または description(小文字化)に `vrchat` を含む**動画のみ採用(ユーザー指定基準)。判定キーワードは定数配列 `VRCHAT_KEYWORDS = ["vrchat"]`(追加が1行で済む構造)。**収集範囲は全世界**(relevanceLanguage=ja は日本語への関連度ヒントにすぎず言語フィルタではない。海外言語の VRChat 配信も掲載対象とする — 絞りたくなった場合の言語フィルタは将来課題) |
| チャンネル情報 | `videos.list` の `snippet.channelId / channelTitle` から streamers.json を生成(`id = youtubeChannelId = channelId`, `name = channelTitle`, `enabled = true` で既存 `Streamer` 型を維持)。channels.list / playlistItems.list のパイプラインは廃止 |
| streamers の継承(欠落防止) | streamers.json = 今回生成分 ∪ 前回 streamers.json のうち「**今回または前回**の tracked/streams に streamerId として参照が残っている」エントリ(**2世代保持**)。これにより ①部分失敗で引き継いだ Stream ②旧独自 ID の Stream ③**streamers.json だけ rename されて streams.json の rename 前にクラッシュした場合の「旧 streams × 新 streamers」の組**、のいずれでも classify.ts の結合で未知 ID が発生しない(新 streamers が前回参照分を必ず含むため)。不要エントリは参照が消えた次のサイクルで自然に落ちる |
| ブロックリスト | `data/blocklist.yaml` 新設(初期は空配列 `[]`)。エントリは `- channelId: UC...`(必須・非空文字列)+ 任意 `note`(文字列)。channelId 重複・型不正・必須欠落は設定エラーとして非0終了。未知フィールドは無視 |
| streamers.yaml | **廃止**(git から削除)。mock は mock.ts 内蔵の架空チャンネル定義で生成(streamers 引数を廃止) |

### 3.4 失敗時挙動・書込

| 項目 | 決定内容 |
|---|---|
| discovery 失敗 | 縮退運転: warn を出して発見をスキップし、追跡集合の refresh のみで続行。3クエリ中の部分失敗は成功分だけ採用。いずれの場合も `discoveryAttemptedAt` は更新(クールダウン維持) |
| refresh 失敗 | 部分バッチ失敗: 当該バッチの動画は**前回 tracked のエントリを引き継ぎ**、成功分は更新。**全バッチ失敗: 書き込まず非0終了**(既存データ保護) |
| 空書込の可否 | 書込を許可するのは ①refresh 対象が1件以上あり、少なくとも1バッチ成功 ②追跡集合が空(refresh 対象なし)かつ **discovery 3クエリ全成功**で結果0件(真に何もない)のみ。追跡集合が空で discovery が失敗(部分失敗含む)した場合は書き込まず非0終了(初回移行時の空上書き事故防止)。**追跡集合が空でクールダウン中(discovery 未実施)の場合は「成功扱いの無書込」**(exit 0、ログのみ。空データ書込直後の cron で必ず通る正常経路のため) |
| 書込順序 | 両ファイルを一時ファイルに書き検証後、**streamers.json を先に rename → streams.json を後に rename**。途中クラッシュして「旧 streams × 新 streamers」の組になっても、streamers の2世代保持(上記)により前回参照分を必ず含むため UI の結合は壊れない |

### 3.5 クォータ・モード

| 項目 | 決定内容 |
|---|---|
| クォータ上限保証 | **定期 cron 分の上限**(前提: live 同時 ≤ 50件): discovery 300unit × 最大24回/日 = 7,200。refresh は発見回 ≤10unit × 24 = 240、通常回 ≤7unit × 72 = 504 → **合計 ≤ 7,944/日**(無料枠の約79%。失敗リクエストの消費も回数上限に内包)。**保証は定期 cron のみ**: workflow_dispatch は1回につき refresh 最大 7unit(クールダウン中は search なし)、ローカル `--discover` は1回 最大約 310unit が別途加算される。逼迫時の調整弁: クールダウン 60分 → 120分で discovery 分が半減 |
| モード切替 | 現行踏襲: `YOUTUBE_API_KEY` 未設定ならモック(内蔵架空チャンネル。tracked/streams 両方を生成) |
| youtube.ts 公開 IF | `discoverVideoIds(apiKey, fetchFn?)` → クエリごとの成否と ID 集合を返す / `refreshStreams(videoIds, apiKey, fetchFn?)` → `Map<videoId, RefreshResult>`(`{ok:true; stream?: Stream; channel?: {...}} \| {ok:false; error}`。stream 欠落 = 正常な不採用)。成功0件と失敗の型区別は必須。詳細は実装時に codex 調整可 |
| ドキュメント | README の「仕組み」「配信者の追加」節を新方式に書き換え。CLAUDE.md のアーキテクチャ節を同期 |

## 4. 実装設計

### 4.1 変更ファイル

```
scripts/
├── youtube.ts   # 全面改修: search 発見 + videos 一括 refresh + VRChat 判定
├── update.ts    # 改修: クールダウン制御(discovery.json 状態ファイル)・
│                #   tracked/streams 分離・MAX_TRACKED・blocklist・
│                #   streamers 2世代継承・書込順序
├── mock.ts      # 改修: 内蔵架空チャンネル(streamers 引数廃止)
└── models.ts    # GeneratedStreams に tracked を追加、DiscoveryState 型を新設
data/
├── blocklist.yaml   # 新設(空配列)
└── streamers.yaml   # 削除(generated/discovery.json は update が生成)
.github/workflows/update.yml  # update を continue-on-error 化し、
                              # 状態コミット後に失敗判定するステップ構成へ変更
test/                # youtube.test.ts 書き直し・mock.test.ts 追随
README.md / CLAUDE.md
```

### 4.2 変更しないもの

- src/(表示層)一式・classify.ts・thumbnail.ts・CSS・フッター文言(「掲載希望連絡」の見直しは別途ユーザー判断)。update.yml は §4.1 の失敗時状態コミット対応のみ変更(トリガー・cron・デプロイ構成は不変)

## 5. 検証計画

1. **単体テスト**(固定 now・モック fetch):
   - VRChat 判定(title のみ/description のみ/大文字小文字/不一致)
   - クールダウン(60分境界・discovery.json 欠落→発見・**不正/未来日時→発見**・**refresh 全滅や非0終了経路でも discovery.json の試行時刻だけは書かれること**・discoveredAt は3クエリ全成功時のみ更新されること)
   - MAX_TRACKED 超過時の削減順序(ended 古い順 → upcoming 遠い順、live は不削除)
   - 追跡0件 + クールダウン中 → 成功扱いの無書込(exit 0・generated 不変)
   - 追跡集合: 表示窓外の未来 upcoming が tracked に残り streams に出ないこと・窓に入ったら streams に現れること・除去規則①〜⑥
   - search: part=id 構造検証・部分失敗の縮退・全失敗時の refresh 続行
   - refresh: 部分バッチ失敗の動画単位引き継ぎ・**全滅時は streams.json / streamers.json が不変で discovery.json の試行時刻のみ更新されること**
   - 空書込境界: 追跡0+discovery 全成功0件→空書込可 / 追跡0+discovery 失敗→非0終了
   - streamers 継承: 引き継ぎ Stream の streamerId が streamers.json に必ず存在(上位集合不変条件)・旧独自 ID の初回移行
   - blocklist: 除外・空文字/重複/型不正で非0終了・未知フィールド無視
2. **型・ビルド**: `npm run check` 0 errors / `npm run build` 成功
3. **実データ確認**: `npm run update -- --discover` → タイトル/説明文に VRChat を含む配信のみが入ること・**リスト外配信者が取得されること**・dev サーバーでカード表示確認。直後に引数なし update → 発見スキップ(ログ確認)・refresh のみ実行
4. **クォータ実測**: 発見1回 ≈ 300unit を Google Cloud Console で確認
5. **本番**: push 後の cron/dispatch 実行で discovery ログ・生成データ・数時間後の tracked 維持を確認

## 6. 影響範囲・リスク

- **編集方針の転換**: キュレーション制 → 自動掲載制。スパム・低品質・海外言語の配信が載り得る(blocklist で事後対応)。フッター「掲載希望連絡」文言は実態とずれるが本計画では変更しない(実装レポートでユーザー判断事項として提示)
- **発見の取りこぼし**(仕様として受容): タイトル/説明文に VRChat が無い配信・公開日時順50件圏外の動画・古い予約枠。completed クエリの補足力も限定的。運用で問題が見えたらキーワード追加・クエリ増・ページング等を再検討
- 既存30名リストは廃止。彼らの配信もタイトル/説明文に VRChat を含む限り自動発見される(含まない配信は載らなくなる = 案Bの意図どおり)
- 発見は最大約60分遅れ。既知動画の状態変化は cron 発火毎(現状は不定期)に追随
- live が同時50件を超えるとクォータ前提が崩れる(現実的には考えにくいが、その場合も 50件=1unit なので増分は軽微)

## 7. 未決事項(デフォルト採用・変更可)

- 判定キーワードは `vrchat` のみで開始(`vrc` は誤爆リスク様子見)
- クールダウン60分・maxResults 50・MAX_TRACKED=300 はデフォルト値(運用で調整可)
- 海外言語配信の扱い(現状: 掲載する)。日本語絞りが必要になったら言語判定フィルタを別途計画

## 8. 実施結果

- §3.1〜§3.5 のコンテンツ起点収集、追跡集合、失敗時保護、クールダウン永続化、動的チャンネル生成、blocklist、モック内蔵チャンネルを実装した
- `update.yml` は update の結果を保持したまま generated を先にコミットし、update 失敗時はテスト・ビルド・デプロイ前にジョブを失敗させる構成へ変更した。トリガー、cron、デプロイ構成は変更していない
- §5-1 の単体テストを固定 now・モック fetch で実装し、既存 classify/thumbnail テストを含む28件が成功した
- `npm run check` と `npm run build` は成功。`npm test` と `npm run update` は実行環境の tsx IPC ソケット制約により、それぞれ `node --import tsx --test test/*.test.ts` と `YOUTUBE_API_KEY` を空に固定した `node --import tsx scripts/update.ts` で代替し成功した
- 実 API 確認、クォータ実測、本番確認は指示に従い未実施。詳細は実装レポート `202608010022_content_first_collection.md` を参照
