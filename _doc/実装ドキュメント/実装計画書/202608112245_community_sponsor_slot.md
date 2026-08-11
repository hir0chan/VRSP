# コミュニティ枠(スポンサーカード)+ 支援導線 実装計画書

日付: 2026-08-11_22:45(codex レビュー反映: 2026-08-11_23:10)
種別: 計画型
状態: **実装・検証完了**(文末「実施結果」を参照)
担当: コーディング codex / レビュー・検証 Claude

## 1. 背景・目的

サイトへの広告スペース設置の検討(cclog L416-418)を経て、方向性は「アドネットワーク型ではなく、コミュニティとのつながりを重視した C(機材紹介)・D(直販スポンサー枠)・E(支援導線)」に決定した。ユーザー確認により以下が確定している:

- **D: コミュニティ枠は有償(少額固定)** — 全掲載カードに「PR」表記が必須(景品表示法・ステマ規制対応)
- **E: 支援プラットフォームは未開設** — 差し込み口だけ用意し、開設後に URL を記入する
- **募集チャネルは X(@hir0chan_vrc)の DM** — フッターに既存導線あり、募集カードから直接リンクする

本計画は Phase 1 として D と E の受け皿を実装する。C(機材紹介コンテンツページ)は Phase 2 として別計画書で扱う。金額設定・掲載規約の文面は DM でのやりとりで運用するためコード外(本計画のスコープ外)。

## 3. 確定仕様

| 項目 | 決定内容 |
|---|---|
| データ管理 | `data/sponsors.yaml`(手編集)。ルートは配列。ビルド時に読み込み静的埋め込み。外部スクリプトなし |
| エントリ構造 | `id`(必須・一意)/ `name`(必須)/ `url`(必須)/ `descriptionJa`(必須)/ `descriptionEn`(必須)/ `until`(任意・`yyyy-MM-dd`) |
| 文字列の空白規律 | 全文字列フィールドは前後空白を不正として throw(trim 補正はしない。手編集ファイルは fail-fast で誤記を顕在化させる) |
| `url` の検証 | `new URL(value)` がパース成功し、かつ `protocol === "https:"` であること(`https://` 単体・相対 URL・http は不正) |
| `until` の検証 | `yyyy-MM-dd` 形式かつ実在日付であること(`2026-02-29` のような非実在日は不正、閏年 `2028-02-29` は正)。非文字列(数値・null)は不正 |
| 掲載期限の判定 | `until >= getJstDateKey(now)` の**文字列比較**(`src/lib/classify.ts:47` の既存関数を再利用)。時刻演算を持たないため 23:59:59.999 問題が構造的に発生しない。`until` 当日は JST でその日いっぱい掲載 |
| 掲載終了のセマンティクス | 「期限日経過後、**最初に成功したビルドのデプロイ時点**で掲載終了」。通常は最大約15分+ビルド・デプロイ時間の残留、cron 遅延・失敗時はさらに延びる。厳密時刻での終了は保証しない(静的サイトの許容トレードオフとして仕様化。クライアント JS は追加しない) |
| 表示位置 | 「今後の配信」セクションの後、フッターの前に専用セクション |
| セクション構成 | 既存 `SectionHeader`(eyebrow: `COMMUNITY`)+ `card-grid` に `SponsorCard` を並べ、末尾に募集カードを常設 |
| PR 表記 | 掲載カードには「PR」バッジを常時表示。募集カード(自サイトの案内)には付けない |
| 募集カード | 「この枠に掲載しませんか?」+ X の DM(`https://x.com/hir0chan_vrc`)へのリンク。スポンサー0件でもセクションごと表示する(募集導線自体が目的のため) |
| 画像 | Phase 1 は非対応。テキストカード(name / description / リンク)のみ |
| 支援導線(E) | `src/lib/site.ts` に `supportUrl` 定数(初期値は空文字)。空ならフッターに何も出さない。開設後に URL を記入するだけで表示される |
| エラー時挙動 | sponsors.yaml の構造不正・重複 id・不正 URL・不正日付・YAML 構文エラー・ファイル欠落は例外で **ビルド失敗**(blocklist.yaml と同じ「設定エラーで既存を壊さない」方針) |
| 既存挙動との関係 | 配信データの取得・分類・表示、フィルタ、i18n の既存キーは不変 |

### 成立性の根拠(調査済み)

- Astro 5 の `.astro` frontmatter はビルド側で実行されるため `node:fs` + `yaml`(既存 devDependency)の利用が成立し、ブラウザーバンドルにも入らない(codex レビューで確認済み)
- `yaml` パッケージは `scripts/update.ts` の blocklist 読込で使用実績があり、依存追加ゼロで済む
- `getJstDateKey`(`src/lib/classify.ts:47`)が JST の `yyyy-MM-dd` 文字列を返す実装として既存。無効な `Date` を渡すと `Intl.DateTimeFormat` が `RangeError` を投げるため、不正な `now` も自然にビルド失敗となる
- スポンサー読込時の例外は `astro build` を失敗させ、`update.yml` の `deploy` ジョブは `build` 成功が前提のため、壊れた成果物はデプロイされず既存の Pages が残る(codex レビューで確認済み)
- cron が15分毎に build するため、`until` によるビルド時除外だけで期限運用が成立する
- フッター・X ハンドル(`@hir0chan_vrc`)は `Layout.astro` に既存で、募集リンク先として利用できる

## 4. 実装設計

### 4.1 データ・ロジック層

**新規 `data/sponsors.yaml`** — 初期状態は空配列 `[]` とコメントで記入例を残す。

**新規 `src/lib/sponsors.ts`** — 純関数のみ(副作用分離の慣習に従い、fs 読込は呼び出し側)。

```ts
import { getJstDateKey } from "./classify.js";

export interface SponsorEntry {
  id: string;
  name: string;
  url: string;
  descriptionJa: string;
  descriptionEn: string;
  until?: string; // yyyy-MM-dd (JST)
}

// 構造検証。不正は Error を throw(ビルド失敗で本番保護)
export function parseSponsors(raw: unknown): SponsorEntry[];

// until >= getJstDateKey(now) の文字列比較で期限内のみ返す
export function filterActiveSponsors(entries: SponsorEntry[], now: Date): SponsorEntry[];
```

検証内容: ルート配列 / 各要素オブジェクト / 必須キー非空文字列・前後空白なし / `url` は `new URL` 成功かつ `https:` プロトコル / `id` 重複なし / `until` は `yyyy-MM-dd` 形式・実在日付・文字列型。

**新規 `src/lib/site.ts`**

```ts
// 支援プラットフォーム開設後に URL を記入する。空文字の間はフッターに表示されない
export const supportUrl = "";
```

### 4.2 フロントエンド

- **新規 `src/components/SponsorCard.astro`** — props: `sponsor: SponsorEntry`, `locale: Locale`。name / description(locale で `descriptionJa` / `descriptionEn` を切替)/ 外部リンク(`target="_blank" rel="noreferrer nofollow sponsored"`)/ 「PR」バッジ
- **変更 `src/components/HomePage.astro`** — frontmatter に読込を追加:

  ```ts
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import { parse } from "yaml";
  const raw: unknown = parse(readFileSync(resolve(process.cwd(), "data/sponsors.yaml"), "utf8"));
  const sponsors = filterActiveSponsors(parseSponsors(raw), new Date());
  ```

  `parse()` の返り値は型定義上 `any` のため、直ちに `unknown` へ閉じ込めて `any` 禁止方針を守る。`new Date()` は `classifyStreams` と同じ運用。「今後の配信」セクションの後に COMMUNITY セクションを追加し、`SponsorCard` 列 + 募集カードを描画
- **変更 `src/layouts/Layout.astro`** — `supportUrl` が非空のときのみ、footer-note に応援リンクを1行追加
- **変更 `src/lib/i18n.ts`** — 追加キー: `sponsorSection`(ja「コミュニティ枠」/ en "Community")、`sponsorPrLabel`(「PR」/ "PR")、`sponsorRecruitTitle`(「この枠に掲載しませんか？」/ "Want to be featured here?")、`sponsorRecruitCopy`(掲載募集の説明 + DM 誘導)、`sponsorRecruitCta`(「X の DM で相談」/ "DM us on X")、`supportLinkLabel`(「このサイトを応援する」/ "Support this site")
- **変更 `src/styles/global.css`** — スポンサーカード・募集カード・PR バッジのスタイル。コントラスト規則遵守: PR バッジ等の小さい赤文字・白抜き地色は `--accent-deep`、`--accent` は大テキスト・装飾のみ。ライトテーマ・Zen Maru Gothic の既存トーンに合わせる

### 4.3 変更しないもの

- `scripts/`(update.ts / youtube.ts / twitch.ts / mock.ts / models.ts)と `data/generated/*` の生成フロー
- `src/lib/classify.ts` / `thumbnail.ts`、`StreamCard.astro`、プラットフォームフィルタ・日本語のみトグルの挙動
- `.github/workflows/`(ビルドコマンド不変のため)
- 既存 i18n キーの文言

## 5. 検証計画

ユニットテストは `test/sponsors.test.ts` を新規作成し `npx tsx --test test/sponsors.test.ts` で実行する。

1. **正常系(ユニット)**:
   - 正しい配列(until あり/なし混在)が通り、値がそのまま保持されること
   - `until` なしのエントリは任意の now で常に掲載されること
   - 閏年 `2028-02-29`、月末日付(`2026-04-30` 等)が受理されること
2. **異常系(ユニット)** — いずれも throw すること:
   - ルートが配列でない / 要素が非オブジェクト
   - 必須キーの欠落・空文字・前後空白付き文字列(` id `、`name ` 等)
   - `url`: `https://`(ホストなし)、`http://example.com`、相対 URL、非文字列
   - `id` 重複
   - `until`: `2026-13-99`、`20260811`、非実在日 `2026-02-29`、数値、null
3. **境界(ユニット)**:
   - `until: "2026-08-11"` に対し、now = JST 2026-08-11 23:59:59.999(UTC で `2026-08-11T14:59:59.999Z`)は掲載、now = JST 2026-08-12 00:00:00.000(UTC で `2026-08-11T15:00:00.000Z`)は除外
   - 無効な now(`new Date(Number.NaN)`)で `filterActiveSponsors` が throw すること(`Intl.DateTimeFormat` の `RangeError`)
4. **ビルド保護(統合)**: `data/sponsors.yaml` に対し以下を1ケースずつ実施し、各ケース終了ごとに正しい内容へ明示的に戻してから次に進む(sponsors.yaml は本実装で新規作成する未コミットファイルのため `git checkout --` は使わない):
   - (a) YAML 構文エラーに書き換え → `npm run build` が非0終了 → 正しい内容に戻す
   - (b) `until: 123`(数値)に書き換え → 非0終了 → 正しい内容に戻す
   - (c) 一時リネームで欠落状態に → 非0終了 → 直後に必ず元のパスへ戻す
   - 最終確認: `data/sponsors.yaml` の内容がテスト前の正しい内容(空配列+記入例コメント)に一致していること
5. **表示(実機)**: `npm run dev` + chrome-devtools で確認。確認後、ダミーエントリと `supportUrl` 仮値を削除し `git diff` で原状回復を確認:
   - `http://localhost:4321/VRSP/` と `http://localhost:4321/VRSP/en/` の両方
   - 0件時: 募集カードのみのセクションが表示され、X DM リンクが `https://x.com/hir0chan_vrc` を指すこと
   - ダミー1件時: PR バッジ表示、locale に応じた description 切替、リンクに `target="_blank"` と `rel="noreferrer nofollow sponsored"` が付くこと
   - 画面幅 375px(モバイル)と 1280px(デスクトップ)でカードレイアウトが崩れないこと
   - `supportUrl` に仮 URL を設定するとフッターに応援リンクが出て、空文字に戻すと消えること
6. **回帰**: `npm test`(既存全テスト)、`npm run check`、`npm run build` がすべて成功。配信セクションの表示が不変であること

## 6. 影響範囲・リスク

- 影響は表示層(`HomePage.astro` / `Layout.astro` / `i18n.ts` / `global.css`)と新規ファイルのみ。データ取得パイプラインに変更なし
- sponsors.yaml の記入ミスはビルド失敗として顕在化する(本番は最後に成功したデプロイが残るため実害なし)。cron 通知で気付ける
- 掲載終了は期限日経過後の次回成功デプロイ時点であり、cron 障害時は残留が延びる(§3 でセマンティクスとして仕様化済み)
- 有償掲載に伴う法的表記は「PR」バッジで担保。ステマ規制(2023年10月施行)の「広告であることの明示」に対応
- GitHub Pages 規約(商用主体サイトの禁止)については、少額・小規模のコミュニティ枠は主従の「従」に留まる範囲と判断。本格化する場合は Cloudflare Pages 移行(`_doc/temp/202608112220_ドメイン議論まとめ.md` §2)とセットで再検討する

## 7. 未決事項(デフォルト採用・変更可)

- セクション位置はページ下部(「今後の配信」の後)で開始し、反応を見て LIVE/TODAY 間への引き上げを検討
- スポンサー画像(ロゴ・バナー)対応は掲載第1号が決まってから追加
- 掲載案内の専用ページ(規約・料金表)は需要が出てから Phase 2 で検討(当面は DM で個別案内)
- 募集カードの文言は実装時に微調整可
- `supportUrl` の非空時 URL 検証(codex 任意指摘)は手編集の TS 定数のため現段階では見送り。記入ミスが起きたら追加する

## 8. codex レビュー履歴

- 2026-08-11 初回レビュー: 要修正5点(until 判定のミリ秒曖昧性 → JST 日付文字列比較に変更 / URL 検証強化 / 掲載終了セマンティクスの明記 / 検証計画の拡充 / frontmatter 読込の具体化)。全点反映済み
- 2026-08-11 再レビュー: 残指摘1点(ビルド保護テストの原状回復手順 — 未追跡ファイルに `git checkout --` は不成立)。ケース毎の明示的復元・リネーム即時復帰・内容一致確認に修正済み

## 9. 実施結果(2026-08-11 実装・検証完了)

### 実装

計画通り実装(コーディング: codex、レビュー: Claude)。計画からの逸脱なし。

### 検証結果

| 検証 | 結果 |
|---|---|
| ユニット(sponsors 9件を含む全63件) | ✅ 63/63 パス |
| `npm run check` | ✅ 0 errors / 0 warnings / 0 hints |
| ビルド保護 (a) YAML 構文エラー (b) 数値 until (c) ファイル欠落 | ✅ 3ケースとも非0終了。各ケース後に復元、最終内容一致確認済み |
| 実機 ja/en(0件時: 募集カードのみ、X DM リンク) | ✅ |
| 実機 ja/en(ダミー1件: PR バッジ `--accent-deep`(#c22f36)、locale 別 description、`rel="noreferrer nofollow sponsored"` `target="_blank"`) | ✅ |
| レスポンシブ(375px エミュレーション・1280px、横スクロールなし) | ✅ |
| `supportUrl` 仮値でフッター表示・空文字で非表示 | ✅ |
| ダミー・仮値の原状回復 | ✅ 復元後に全テスト・check・build 再実行し成功 |
| 回帰(`npm run build` 日英2ページ生成) | ✅ |

### 変更ファイル一覧

- 新規: `data/sponsors.yaml`, `src/lib/sponsors.ts`, `src/lib/site.ts`, `src/components/SponsorCard.astro`, `test/sponsors.test.ts`
- 変更: `src/components/HomePage.astro`, `src/layouts/Layout.astro`, `src/lib/i18n.ts`, `src/styles/global.css`

### 残課題・補足

- `supportUrl` は支援プラットフォーム開設後に `src/lib/site.ts` へ記入するだけで表示される
- 掲載開始時は `data/sponsors.yaml` の `[]` を削除してエントリを記入する(コメントの記入例参照)
