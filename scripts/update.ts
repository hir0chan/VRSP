import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generateMockStreams, MOCK_STREAMERS } from "./mock.js";
import type {
  DiscoveryState,
  GeneratedStreamers,
  GeneratedStreams,
  Stream,
  Streamer,
} from "./models.js";
import {
  discoverVideoIds,
  filterStreams,
  refreshStreams,
  type ChannelInfo,
  type DiscoveryResult,
  type RefreshResult,
} from "./youtube.js";

export const MAX_TRACKED = 300;
const DISCOVERY_COOLDOWN_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface OutputPaths {
  streams: string;
  streamers: string;
}

interface PreviousData {
  tracked: Stream[];
  streams: Stream[];
}

export interface BlocklistEntry {
  channelId: string;
  note?: string;
}

export interface UpdateOptions {
  rootDir?: string;
  now?: Date;
  beforeCommit?: () => void | Promise<void>;
  apiKey?: string;
  fetchFn?: typeof fetch;
  forceDiscovery?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isStream(value: unknown): value is Stream {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.streamerId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.thumbnail !== "string" ||
    typeof value.url !== "string" ||
    (value.status !== "upcoming" && value.status !== "live" && value.status !== "ended")
  ) return false;
  for (const field of ["scheduledStart", "actualStart", "actualEnd"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  return value.viewers === undefined || typeof value.viewers === "number";
}

function isStreamer(value: unknown): value is Streamer {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.youtubeChannelId === "string" &&
    typeof value.enabled === "boolean";
}

export function validateBlocklist(value: unknown): BlocklistEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("blocklist.yaml のルートは配列である必要があります");
  }
  const entries: BlocklistEntry[] = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`blocklist.yaml[${index}] はオブジェクトである必要があります`);
    }
    if (typeof item.channelId !== "string" || item.channelId.trim() === "") {
      throw new Error(`blocklist.yaml[${index}].channelId は必須の非空文字列です`);
    }
    if (item.note !== undefined && typeof item.note !== "string") {
      throw new Error(`blocklist.yaml[${index}].note は文字列である必要があります`);
    }
    return {
      channelId: item.channelId,
      ...(item.note === undefined ? {} : { note: item.note }),
    };
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.channelId)) {
      throw new Error(`blocklist.yaml に重複した channelId があります: ${entry.channelId}`);
    }
    seen.add(entry.channelId);
  }
  return entries;
}

export async function loadBlocklist(path: string): Promise<BlocklistEntry[]> {
  return validateBlocklist(parse(await readFile(path, "utf8")));
}

export async function loadEnvFile(path: string): Promise<void> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === "\"" || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function serialize(value: GeneratedStreams | GeneratedStreamers | DiscoveryState): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  return content;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }
}

async function writeAtomic(path: string, value: DiscoveryState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialize(value), "utf8");
    await rename(temporary, path);
  } catch (error: unknown) {
    await removeIfPresent(temporary);
    throw error;
  }
}

export async function writeGeneratedFiles(
  paths: OutputPaths,
  streams: GeneratedStreams,
  streamers: GeneratedStreamers,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  await Promise.all([mkdir(dirname(paths.streams), { recursive: true }), mkdir(dirname(paths.streamers), { recursive: true })]);
  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  const temporary = { streams: `${paths.streams}.${suffix}`, streamers: `${paths.streamers}.${suffix}` };
  try {
    await Promise.all([
      writeFile(temporary.streams, serialize(streams), "utf8"),
      writeFile(temporary.streamers, serialize(streamers), "utf8"),
    ]);
    await beforeCommit?.();
    await rename(temporary.streamers, paths.streamers);
    await rename(temporary.streams, paths.streams);
  } catch (error: unknown) {
    await Promise.all([removeIfPresent(temporary.streams), removeIfPresent(temporary.streamers)]);
    throw error;
  }
}

async function loadPreviousData(path: string): Promise<PreviousData> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || !Array.isArray(value.streams) || !value.streams.every(isStream)) {
      throw new Error("streams.json の構造が不正です");
    }
    if (value.tracked !== undefined && (!Array.isArray(value.tracked) || !value.tracked.every(isStream))) {
      throw new Error("streams.json の tracked が不正です");
    }
    return { tracked: value.tracked === undefined ? value.streams : value.tracked, streams: value.streams };
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`前回の streams.json を読み込めませんでした: ${message}`);
    }
    return { tracked: [], streams: [] };
  }
}

async function loadPreviousStreamers(path: string): Promise<Streamer[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || !Array.isArray(value.streamers) || !value.streamers.every(isStreamer)) {
      throw new Error("streamers.json の構造が不正です");
    }
    return value.streamers;
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`前回の streamers.json を読み込めませんでした: ${message}`);
    }
    return [];
  }
}

async function loadDiscoveryState(path: string): Promise<Partial<DiscoveryState>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? {
      ...(typeof value.discoveryAttemptedAt === "string" ? { discoveryAttemptedAt: value.discoveryAttemptedAt } : {}),
      ...(typeof value.discoveredAt === "string" ? { discoveredAt: value.discoveredAt } : {}),
    } : {};
  } catch {
    return {};
  }
}

export function shouldDiscover(
  state: Partial<DiscoveryState>,
  now: Date,
  force = false,
): boolean {
  if (force) return true;
  if (Number.isNaN(now.getTime())) throw new Error("now は有効な日時で指定してください");
  const attempted = state.discoveryAttemptedAt === undefined
    ? Number.NaN
    : new Date(state.discoveryAttemptedAt).getTime();
  if (Number.isNaN(attempted) || attempted > now.getTime()) return true;
  return now.getTime() - attempted >= DISCOVERY_COOLDOWN_MS;
}

function retentionFilter(streams: Stream[], now: Date, blocked: Set<string>): Stream[] {
  const endedBoundary = now.getTime() - DAY_MS;
  const staleUpcomingBoundary = now.getTime() - 7 * DAY_MS;
  return streams.filter((stream) => {
    if (blocked.has(stream.streamerId)) return false;
    if (stream.status === "ended") {
      const time = stream.actualEnd === undefined ? Number.NaN : new Date(stream.actualEnd).getTime();
      return !Number.isNaN(time) && time >= endedBoundary;
    }
    if (stream.status === "upcoming") {
      const time = stream.scheduledStart === undefined ? Number.NaN : new Date(stream.scheduledStart).getTime();
      return !Number.isNaN(time) && time >= staleUpcomingBoundary;
    }
    return true;
  });
}

export function limitTracked(streams: Stream[], maxNonLive = MAX_TRACKED): Stream[] {
  const nonLive = streams.filter((stream) => stream.status !== "live");
  let removeCount = Math.max(0, nonLive.length - maxNonLive);
  if (removeCount === 0) return streams;
  const removals = new Set<string>();
  const endedOldestFirst = nonLive
    .filter((stream) => stream.status === "ended")
    .sort((a, b) => new Date(a.actualEnd ?? 0).getTime() - new Date(b.actualEnd ?? 0).getTime());
  for (const stream of endedOldestFirst) {
    if (removeCount === 0) break;
    removals.add(stream.id);
    removeCount -= 1;
  }
  const upcomingFarthestFirst = nonLive
    .filter((stream) => stream.status === "upcoming")
    .sort((a, b) => new Date(b.scheduledStart ?? 0).getTime() - new Date(a.scheduledStart ?? 0).getTime());
  for (const stream of upcomingFarthestFirst) {
    if (removeCount === 0) break;
    removals.add(stream.id);
    removeCount -= 1;
  }
  return streams.filter((stream) => !removals.has(stream.id));
}

export function mergeRefreshResults(
  targetIds: Iterable<string>,
  results: Map<string, RefreshResult>,
  previousTracked: Stream[],
): { streams: Stream[]; channels: ChannelInfo[]; successCount: number } {
  const previousById = new Map(previousTracked.map((stream) => [stream.id, stream]));
  const streams: Stream[] = [];
  const channels: ChannelInfo[] = [];
  let successCount = 0;
  for (const id of targetIds) {
    const result = results.get(id);
    if (result?.ok === true) {
      successCount += 1;
      if (result.stream !== undefined) streams.push(result.stream);
      if (result.channel !== undefined) channels.push(result.channel);
    } else {
      const previous = previousById.get(id);
      if (previous !== undefined) streams.push(previous);
    }
  }
  return { streams, channels, successCount };
}

function buildStreamers(
  channels: ChannelInfo[],
  previousStreamers: Streamer[],
  currentTracked: Stream[],
  previousData: PreviousData,
): Streamer[] {
  const entries = new Map<string, Streamer>();
  const references = new Set([
    ...currentTracked.map((stream) => stream.streamerId),
    ...previousData.tracked.map((stream) => stream.streamerId),
    ...previousData.streams.map((stream) => stream.streamerId),
  ]);
  for (const streamer of previousStreamers) {
    if (references.has(streamer.id)) entries.set(streamer.id, streamer);
  }
  for (const channel of channels) {
    entries.set(channel.id, { id: channel.id, name: channel.name, youtubeChannelId: channel.id, enabled: true });
  }
  return [...entries.values()];
}

function failedDiscoveryResult(error: unknown): DiscoveryResult {
  return {
    videoIds: new Set(),
    successfulQueries: 0,
    failedQueries: [{ eventType: "all", error: error instanceof Error ? error : new Error(String(error)) }],
    allSucceeded: false,
  };
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("now は有効な日時で指定してください");
  const generatedDir = resolve(rootDir, "data/generated");
  const paths = {
    streams: resolve(generatedDir, "streams.json"),
    streamers: resolve(generatedDir, "streamers.json"),
    discovery: resolve(generatedDir, "discovery.json"),
  };
  const blocklist = await loadBlocklist(resolve(rootDir, "data/blocklist.yaml"));
  const previousData = await loadPreviousData(paths.streams);
  const previousStreamers = await loadPreviousStreamers(paths.streamers);
  const configuredApiKey = options.apiKey === undefined ? process.env.YOUTUBE_API_KEY : options.apiKey;
  const apiKey = configuredApiKey?.trim() ?? "";
  const updatedAt = now.toISOString();

  if (apiKey === "") {
    console.log("YOUTUBE_API_KEY が未設定のためモックデータを使用します");
    const tracked = generateMockStreams(now);
    await writeGeneratedFiles(
      paths,
      { updatedAt, tracked, streams: filterStreams(tracked, now) },
      { updatedAt, streamers: MOCK_STREAMERS },
      options.beforeCommit,
    );
    return;
  }

  const discoveryState = await loadDiscoveryState(paths.discovery);
  const discoveryDue = shouldDiscover(discoveryState, now, options.forceDiscovery);
  let discovery: DiscoveryResult | undefined;
  if (discoveryDue) {
    try {
      discovery = options.fetchFn === undefined
        ? await discoverVideoIds(apiKey)
        : await discoverVideoIds(apiKey, options.fetchFn);
    } catch (error: unknown) {
      discovery = failedDiscoveryResult(error);
    }
    const nextState: DiscoveryState = {
      discoveryAttemptedAt: updatedAt,
      ...(discovery.allSucceeded
        ? { discoveredAt: updatedAt }
        : discoveryState.discoveredAt === undefined ? {} : { discoveredAt: discoveryState.discoveredAt }),
    };
    await writeAtomic(paths.discovery, nextState);
    for (const failure of discovery.failedQueries) {
      console.warn(`発見クエリ ${failure.eventType} に失敗しました: ${failure.error.message}`);
    }
  } else {
    console.log("発見クールダウン中のため search.list をスキップします");
  }

  const targetIds = new Set(previousData.tracked.map((stream) => stream.id));
  for (const id of discovery?.videoIds ?? []) targetIds.add(id);
  if (targetIds.size === 0) {
    if (discovery === undefined) {
      console.log("追跡対象がなく発見クールダウン中のため generated は更新しません");
      return;
    }
    if (!discovery.allSucceeded) {
      throw new Error("追跡対象がなく発見も完全成功しなかったため generated を更新しません");
    }
    const streamers = buildStreamers([], previousStreamers, [], previousData);
    await writeGeneratedFiles(paths, { updatedAt, tracked: [], streams: [] }, { updatedAt, streamers }, options.beforeCommit);
    return;
  }

  const refreshResults = options.fetchFn === undefined
    ? await refreshStreams(targetIds, apiKey)
    : await refreshStreams(targetIds, apiKey, options.fetchFn);
  const merged = mergeRefreshResults(targetIds, refreshResults, previousData.tracked);
  if (merged.successCount === 0) {
    throw new Error("全 refresh バッチが失敗したため generated を更新しません");
  }
  for (const [id, result] of refreshResults) {
    if (!result.ok) console.warn(`動画 ${id} の refresh に失敗しました: ${result.error.message}`);
  }
  const blocked = new Set(blocklist.map((entry) => entry.channelId));
  const tracked = limitTracked(retentionFilter(merged.streams, now, blocked));
  const streams = filterStreams(tracked, now);
  const streamers = buildStreamers(merged.channels, previousStreamers, tracked, previousData);
  const referenced = new Set([...tracked, ...streams].map((stream) => stream.streamerId));
  const known = new Set(streamers.map((streamer) => streamer.id));
  for (const id of referenced) {
    if (!known.has(id)) throw new Error(`streamers.json に必要な配信者情報がありません: ${id}`);
  }
  await writeGeneratedFiles(paths, { updatedAt, tracked, streams }, { updatedAt, streamers }, options.beforeCommit);
}

function isCommandLineEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isCommandLineEntry()) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--discover");
  if (unknown.length > 0) {
    console.error(`更新に失敗しました: 未知の引数です: ${unknown.join(", ")}`);
    process.exitCode = 1;
  } else {
    loadEnvFile(resolve(process.cwd(), ".env"))
      .then(() => runUpdate({ forceDiscovery: args.includes("--discover") }))
      .then(() => console.log("generated データを更新しました"))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`更新に失敗しました: ${message}`);
        process.exitCode = 1;
      });
  }
}
