import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnouncedEntry, DigestState, Stream, Streamer } from "./models.js";
import { isStream, isStreamer } from "./update.js";

const POST_INTERVAL_MS = 120 * 60 * 1_000;
const ANNOUNCED_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POST_LENGTH = 280;
const MAX_NAME_LENGTH = 40;
const SITE_URL = "https://vcha-antenna.com/";
const SITE_URL_WEIGHT = 23;
const IFTTT_EVENT = "vrsp_digest";

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
  beforeStateCommit?: () => void | Promise<void>;
}

export type DigestResult = "dry-run" | "skipped-keys" | "initialized" | "skipped" | "posted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export function announcedKey(stream: Stream): string {
  return `${stream.platform ?? "youtube"}:${stream.id}`;
}

function actualStartTime(stream: Stream): number {
  if (stream.actualStart === undefined) return Number.POSITIVE_INFINITY;
  const time = new Date(stream.actualStart).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function compareKeys(left: Stream, right: Stream): number {
  const leftKey = announcedKey(left);
  const rightKey = announcedKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function selectNewLives(streams: Stream[], announced: AnnouncedEntry[]): Stream[] {
  const known = new Set(announced.map((entry) => entry.id));
  return streams
    .filter((stream) => stream.status === "live" && stream.isJapanese === true && !known.has(announcedKey(stream)))
    .sort((left, right) => actualStartTime(left) - actualStartTime(right) || compareKeys(left, right));
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

function truncateWeighted(text: string, maximum: number): string {
  if (weightedLength(text) <= maximum) return text;
  const suffix = "…";
  const budget = maximum - weightedLength(suffix);
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (weightedLength(result + segment) > budget) break;
    result += segment;
  }
  return result + suffix;
}

export function sanitizeName(name: string): string {
  const normalized = name
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[@＠#＃.．。｡]/gu, "・");
  return truncateWeighted(normalized, MAX_NAME_LENGTH);
}

function digestBody(secondLine: string, liveTotal: number): string {
  return `🔴 VRChat配信が新たにスタート!\n${secondLine}\n現在${liveTotal}件がライブ配信中👀`;
}

function digestText(secondLine: string, liveTotal: number): string {
  return `${digestBody(secondLine, liveTotal)}\n${SITE_URL}`;
}

function digestLength(secondLine: string, liveTotal: number): number {
  return weightedLength(`${digestBody(secondLine, liveTotal)}\n`) + SITE_URL_WEIGHT;
}

export function composeDigest(newLives: Stream[], liveTotal: number, streamers: Streamer[]): string {
  const streamerNames = new Map(streamers.map((streamer) => [streamer.id, sanitizeName(streamer.name)]));
  const names = newLives.flatMap((stream) => {
    const name = streamerNames.get(stream.streamerId);
    return name === undefined || name === "" ? [] : [name];
  });
  const included: string[] = [];
  for (const name of names) {
    const candidate = [...included, name];
    const remaining = newLives.length - candidate.length;
    const line = `${candidate.join(" / ")}${remaining > 0 ? ` ほか${remaining}件` : ""}`;
    if (digestLength(line, liveTotal) > MAX_POST_LENGTH) break;
    included.push(name);
  }
  const remaining = newLives.length - included.length;
  const secondLine = included.length === 0
    ? `${newLives.length}件の配信がスタート!`
    : `${included.join(" / ")}${remaining > 0 ? ` ほか${remaining}件` : ""}`;
  const text = digestText(secondLine, liveTotal);
  if (digestLength(secondLine, liveTotal) > MAX_POST_LENGTH) {
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

export function pruneAnnounced(
  announced: AnnouncedEntry[],
  liveKeys: Set<string>,
  now: Date,
): AnnouncedEntry[] {
  const boundary = now.getTime() - ANNOUNCED_RETENTION_MS;
  return announced.filter((entry) => liveKeys.has(entry.id) || new Date(entry.at).getTime() >= boundary);
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
  if (!isRecord(value) || !Array.isArray(value.announced)) {
    throw new Error("digest.json の構造が不正です");
  }
  if (value.lastPostedAt !== undefined && (typeof value.lastPostedAt !== "string" || !validDate(value.lastPostedAt))) {
    throw new Error("digest.json の lastPostedAt が不正な日時です");
  }
  const announced: AnnouncedEntry[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.announced.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new Error(`digest.json の announced[${index}].id が不正です`);
    }
    if (typeof entry.at !== "string" || !validDate(entry.at)) {
      throw new Error(`digest.json の announced[${index}].at が不正な日時です`);
    }
    if (ids.has(entry.id)) throw new Error(`digest.json の announced に重複キーがあります: ${entry.id}`);
    ids.add(entry.id);
    announced.push({ id: entry.id, at: entry.at });
  }
  return {
    announced,
    ...(value.lastPostedAt === undefined ? {} : { lastPostedAt: value.lastPostedAt }),
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
    const newLives = selectNewLives(inputs.streams, state?.announced ?? []);
    console.log(composeDigest(newLives, countLiveJapanese(inputs.streams), inputs.streamers));
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
  const liveStreams = inputs.streams.filter((stream) => stream.status === "live");
  const liveKeys = new Set(liveStreams.map(announcedKey));
  if (state === undefined) {
    const announced = [...liveKeys].map((id) => ({ id, at: now.toISOString() }));
    await writeStateAtomic(paths.state, { announced }, options.beforeStateCommit);
    console.log("digest.json が未作成のため現在の live をベースラインとして記録します");
    return "initialized";
  }

  const newLives = selectNewLives(inputs.streams, state.announced);
  const postingDue = shouldPost(state, now);
  if (!postingDue || newLives.length === 0) {
    console.log("投稿条件を満たさないためダイジェスト投稿をスキップします");
    return "skipped";
  }

  const text = composeDigest(newLives, countLiveJapanese(inputs.streams), inputs.streamers);
  await postToIfttt(text, iftttWebhookKey, options.fetchFn);
  const added = newLives.map((stream) => ({ id: announcedKey(stream), at: now.toISOString() }));
  const announced = pruneAnnounced([...state.announced, ...added], liveKeys, now);
  await writeStateAtomic(paths.state, { lastPostedAt: now.toISOString(), announced }, options.beforeStateCommit);
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
