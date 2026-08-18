import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DigestState, Stream, Streamer } from "./models.js";
import { isStream, isStreamer } from "./update.js";

const POST_INTERVAL_MS = 120 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POST_LENGTH = 280;
const MAX_NAME_LENGTH = 40;
const SITE_URL = "https://vcha-antenna.com/";
const SITE_URL_WEIGHT = 23;
const IFTTT_EVENT = "vrsp_digest";
const HASHTAGS = "#VRChat #ぶいちゃ配信アンテナ";
const HEADING = "👉️ 今おすすめのVRChat配信は?";

interface DigestInputs {
  streams: Stream[];
  streamers: Streamer[];
}

export interface RunDigestOptions {
  rootDir?: string;
  now?: Date;
  dryRun?: boolean;
  iftttWebhookKey?: string;
  youtubeApiKey?: string;
  fetchFn?: typeof fetch;
  randomFn?: () => number;
  beforeStateCommit?: () => void | Promise<void>;
}

export type DigestResult = "dry-run" | "skipped-keys" | "skipped" | "posted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export function streamKey(stream: Stream): string {
  return `${stream.platform ?? "youtube"}:${stream.id}`;
}

export function countLiveJapanese(streams: Stream[]): number {
  return streams.filter((stream) => stream.status === "live" && stream.isJapanese === true).length;
}

function codePointWeight(codePoint: number): number {
  if (
    codePoint <= 0x10ff ||
    (codePoint >= 0x2000 && codePoint <= 0x200d) ||
    (codePoint >= 0x2010 && codePoint <= 0x201f) ||
    (codePoint >= 0x2032 && codePoint <= 0x2037)
  ) return 1;
  return 2;
}

export function weightedLength(text: string): number {
  let weight = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    weight += codePointWeight(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return weight;
}

export function weightedPostLength(text: string): number {
  const urlPattern = /https?:\/\/[^\s]+/gu;
  let weight = 0;
  let start = 0;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index;
    weight += weightedLength(text.slice(start, index)) + SITE_URL_WEIGHT;
    start = index + match[0].length;
  }
  return weight + weightedLength(text.slice(start));
}

export function truncateWeighted(text: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (weightedLength(text) <= maximum) return text;
  const suffix = "…";
  const budget = maximum - weightedLength(suffix);
  if (budget < 0) return "";
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (weightedLength(result + segment) > budget) break;
    result += segment;
  }
  return result + suffix;
}

export function sanitizePostText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\b([a-z][a-z0-9+.-]*)[：:][／/]{2}/giu, "$1・//")
    .replace(/[@＠#＃.．。｡]/gu, "・")
    .replace(/\s+/gu, " ")
    .trim();
}

export function selectFeatured(
  streams: Stream[],
  lastFeaturedId?: string,
  randomFn: () => number = Math.random,
): Stream | undefined {
  const liveJapanese = streams.filter((stream) => stream.status === "live" && stream.isJapanese === true);
  const titled = liveJapanese.filter((stream) => sanitizePostText(stream.title) !== "");
  const eligible = titled.length > 0 ? titled : liveJapanese;
  const candidates = eligible.length >= 2
    ? eligible.filter((stream) => streamKey(stream) !== lastFeaturedId)
    : eligible;
  if (candidates.length === 0) return undefined;
  const random = randomFn();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error("randomFn は0以上1未満を返してください");
  }
  return candidates[Math.floor(random * candidates.length)];
}

function digestText(detail: string, link: string, liveTotal: number): string {
  return `${HEADING}\n${detail}\n${link}\n現在${liveTotal}件がライブ配信中👀\n${HASHTAGS}`;
}

export function composeDigest(featured: Stream, liveTotal: number, streamers: Streamer[]): string {
  const rawName = streamers.find((streamer) => streamer.id === featured.streamerId)?.name ?? "";
  const name = truncateWeighted(sanitizePostText(rawName), MAX_NAME_LENGTH);
  const sanitizedTitle = sanitizePostText(featured.title);
  const link = name === "" ? SITE_URL : `${SITE_URL}?q=${encodeURIComponent(rawName)}`;
  let detail: string;
  if (sanitizedTitle === "") {
    detail = name === "" ? "おすすめの配信" : name;
  } else {
    const nameSuffix = name === "" ? "" : `(${name})`;
    const titleBudget = MAX_POST_LENGTH - weightedPostLength(digestText(nameSuffix, link, liveTotal));
    detail = `${truncateWeighted(sanitizedTitle, titleBudget)}${nameSuffix}`;
  }
  const text = digestText(detail, link, liveTotal);
  if (weightedPostLength(text) > MAX_POST_LENGTH) {
    throw new Error("ダイジェスト本文が重み付き280文字を超えています");
  }
  return text;
}

export function shouldPost(state: DigestState, now: Date): boolean {
  const nowTime = now.getTime();
  if (Number.isNaN(nowTime)) throw new Error("now は有効な日時で指定してください");
  if (state.lastPostedAt === undefined) return true;
  const postedTime = new Date(state.lastPostedAt).getTime();
  if (Number.isNaN(postedTime)) throw new Error("digest.json の lastPostedAt が不正な日時です");
  if (postedTime > nowTime + MAX_FUTURE_SKEW_MS) {
    throw new Error("digest.json の lastPostedAt が24時間を超えて未来です");
  }
  if (postedTime > nowTime) return false;
  return nowTime - postedTime >= POST_INTERVAL_MS;
}

export async function postToIfttt(text: string, key: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const url = `https://maker.ifttt.com/trigger/${IFTTT_EVENT}/with/key/${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value1: text }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("IFTTT Webhook の送信に失敗しました");
  }
  if (!response.ok) {
    throw new Error(`IFTTT Webhook が HTTP ${response.status} を返しました`);
  }
}

function validateDigestState(value: unknown): DigestState {
  if (!isRecord(value)) throw new Error("digest.json の構造が不正です");
  if (value.lastPostedAt !== undefined && (typeof value.lastPostedAt !== "string" || !validDate(value.lastPostedAt))) {
    throw new Error("digest.json の lastPostedAt が不正な日時です");
  }
  if (value.lastFeaturedId !== undefined && typeof value.lastFeaturedId !== "string") {
    throw new Error("digest.json の lastFeaturedId が不正です");
  }
  return {
    ...(value.lastPostedAt === undefined ? {} : { lastPostedAt: value.lastPostedAt }),
    ...(value.lastFeaturedId === undefined ? {} : { lastFeaturedId: value.lastFeaturedId }),
  };
}

async function loadState(path: string): Promise<DigestState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateDigestState(value);
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function loadInputs(streamsPath: string, streamersPath: string): Promise<DigestInputs> {
  const [streamsSource, streamersSource] = await Promise.all([
    readFile(streamsPath, "utf8"),
    readFile(streamersPath, "utf8"),
  ]);
  const streamsValue: unknown = JSON.parse(streamsSource);
  const streamersValue: unknown = JSON.parse(streamersSource);
  if (!isRecord(streamsValue) || !Array.isArray(streamsValue.streams) || !streamsValue.streams.every(isStream)) {
    throw new Error("streams.json の構造が不正です");
  }
  if (!isRecord(streamersValue) || !Array.isArray(streamersValue.streamers) || !streamersValue.streamers.every(isStreamer)) {
    throw new Error("streamers.json の構造が不正です");
  }
  return { streams: streamsValue.streams, streamers: streamersValue.streamers };
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }
}

async function writeStateAtomic(
  path: string,
  state: DigestState,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    JSON.parse(content);
    await writeFile(temporary, content, "utf8");
    await beforeCommit?.();
    await rename(temporary, path);
  } catch (error: unknown) {
    await removeIfPresent(temporary);
    throw error;
  }
}

export async function runDigest(options: RunDigestOptions = {}): Promise<DigestResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("now は有効な日時で指定してください");
  const generatedDir = resolve(rootDir, "data/generated");
  const paths = {
    streams: resolve(generatedDir, "streams.json"),
    streamers: resolve(generatedDir, "streamers.json"),
    state: resolve(generatedDir, "digest.json"),
  };

  if (options.dryRun === true) {
    const [inputs, state] = await Promise.all([loadInputs(paths.streams, paths.streamers), loadState(paths.state)]);
    const featured = selectFeatured(inputs.streams, state?.lastFeaturedId, options.randomFn);
    if (featured === undefined) {
      console.log("紹介できる日本語のライブ配信がありません");
    } else {
      console.log(composeDigest(featured, countLiveJapanese(inputs.streams), inputs.streamers));
    }
    return "dry-run";
  }

  const iftttWebhookKey = (options.iftttWebhookKey === undefined
    ? process.env.IFTTT_WEBHOOK_KEY
    : options.iftttWebhookKey)?.trim() ?? "";
  const youtubeApiKey = (options.youtubeApiKey === undefined
    ? process.env.YOUTUBE_API_KEY
    : options.youtubeApiKey)?.trim() ?? "";
  if (iftttWebhookKey === "" || youtubeApiKey === "") {
    console.log("IFTTT_WEBHOOK_KEY または YOUTUBE_API_KEY が未設定のためダイジェスト投稿をスキップします");
    return "skipped-keys";
  }

  const [inputs, state] = await Promise.all([loadInputs(paths.streams, paths.streamers), loadState(paths.state)]);
  const postingDue = shouldPost(state ?? {}, now);
  const featured = selectFeatured(inputs.streams, state?.lastFeaturedId, options.randomFn);
  if (!postingDue || featured === undefined) {
    console.log("投稿条件を満たさないためダイジェスト投稿をスキップします");
    return "skipped";
  }

  const text = composeDigest(featured, countLiveJapanese(inputs.streams), inputs.streamers);
  await postToIfttt(text, iftttWebhookKey, options.fetchFn);
  await writeStateAtomic(paths.state, {
    lastPostedAt: now.toISOString(),
    lastFeaturedId: streamKey(featured),
  }, options.beforeStateCommit);
  console.log("IFTTT Webhook がダイジェストを受け付けました");
  return "posted";
}

function isCommandLineEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isCommandLineEntry()) {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length > 0 && !dryRun) {
    console.error(`未知の引数です: ${args.join(" ")}`);
    process.exitCode = 1;
  } else {
    runDigest({ dryRun }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ダイジェスト処理に失敗しました: ${message}`);
      process.exitCode = 1;
    });
  }
}
