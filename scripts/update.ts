import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generateMockStreams } from "./mock.js";
import type {
  GeneratedStreamers,
  GeneratedStreams,
  Stream,
  Streamer,
} from "./models.js";
import {
  fetchStreams,
  filterStreams,
  type FetchResult,
} from "./youtube.js";

interface OutputPaths {
  streams: string;
  streamers: string;
}

export interface UpdateOptions {
  rootDir?: string;
  now?: Date;
  beforeCommit?: () => void | Promise<void>;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`streamers.yaml[${index}].${field} は必須の文字列です`);
  }
  return value;
}

function parseStreamer(value: unknown, index: number): Streamer {
  if (!isRecord(value)) {
    throw new Error(`streamers.yaml[${index}] はオブジェクトである必要があります`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error(`streamers.yaml[${index}].enabled は boolean である必要があります`);
  }
  return {
    id: requireString(value, "id", index),
    name: requireString(value, "name", index),
    youtubeChannelId: requireString(value, "youtubeChannelId", index),
    enabled: value.enabled,
  };
}

export function validateStreamers(value: unknown): Streamer[] {
  if (!Array.isArray(value)) {
    throw new Error("streamers.yaml のルートは配列である必要があります");
  }

  const streamers = value.map(parseStreamer);
  const ids = new Set<string>();
  const youtubeChannelIds = new Set<string>();
  for (const streamer of streamers) {
    if (ids.has(streamer.id)) {
      throw new Error(`streamers.yaml に重複した id があります: ${streamer.id}`);
    }
    if (youtubeChannelIds.has(streamer.youtubeChannelId)) {
      throw new Error(
        `streamers.yaml に重複した youtubeChannelId があります: ${streamer.youtubeChannelId}`,
      );
    }
    ids.add(streamer.id);
    youtubeChannelIds.add(streamer.youtubeChannelId);
  }
  const enabledStreamers = streamers.filter((streamer) => streamer.enabled);
  if (enabledStreamers.length === 0) {
    throw new Error("streamers.yaml に enabled な配信者がいません");
  }
  return enabledStreamers;
}

export async function loadStreamers(path: string): Promise<Streamer[]> {
  const source = await readFile(path, "utf8");
  return validateStreamers(parse(source));
}

export async function loadEnvFile(path: string): Promise<void> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.at(-1) === quote
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function serialize(value: GeneratedStreams | GeneratedStreamers): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  return content;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isStream(value: unknown): value is Stream {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.streamerId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.thumbnail !== "string" ||
    typeof value.url !== "string" ||
    (value.status !== "upcoming" &&
      value.status !== "live" &&
      value.status !== "ended")
  ) {
    return false;
  }
  for (const field of ["scheduledStart", "actualStart", "actualEnd"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return false;
    }
  }
  return value.viewers === undefined || typeof value.viewers === "number";
}

async function loadPreviousStreams(path: string): Promise<Stream[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      !Array.isArray(value.streams) ||
      !value.streams.every(isStream)
    ) {
      throw new Error("streams.json の構造が不正です");
    }
    return value.streams;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`前回の streams.json を読み込めませんでした: ${message}`);
    return [];
  }
}

export function mergeFetchResults(
  streamers: Streamer[],
  results: Map<string, FetchResult>,
  previousStreams: Stream[],
): { streams: Stream[]; failedStreamerIds: string[] } {
  const streams: Stream[] = [];
  const failedStreamerIds: string[] = [];

  for (const streamer of streamers) {
    const result = results.get(streamer.id);
    if (result?.ok === true) {
      streams.push(...result.streams);
      continue;
    }
    failedStreamerIds.push(streamer.id);
    streams.push(
      ...previousStreams.filter(
        (stream) => stream.streamerId === streamer.id,
      ),
    );
  }
  return { streams, failedStreamerIds };
}

export async function writeGeneratedFiles(
  paths: OutputPaths,
  streams: GeneratedStreams,
  streamers: GeneratedStreamers,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  await mkdir(dirname(paths.streams), { recursive: true });
  await mkdir(dirname(paths.streamers), { recursive: true });

  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  const temporary = {
    streams: `${paths.streams}.${suffix}`,
    streamers: `${paths.streamers}.${suffix}`,
  };

  try {
    await Promise.all([
      writeFile(temporary.streams, serialize(streams), "utf8"),
      writeFile(temporary.streamers, serialize(streamers), "utf8"),
    ]);
    await beforeCommit?.();
    await rename(temporary.streams, paths.streams);
    await rename(temporary.streamers, paths.streamers);
  } catch (error: unknown) {
    await Promise.all([
      removeIfPresent(temporary.streams),
      removeIfPresent(temporary.streamers),
    ]);
    throw error;
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  const streamers = await loadStreamers(resolve(rootDir, "data/streamers.yaml"));
  const configuredApiKey =
    options.apiKey === undefined
      ? process.env.YOUTUBE_API_KEY
      : options.apiKey;
  const apiKey = configuredApiKey?.trim() ?? "";
  let results: Map<string, FetchResult>;

  if (apiKey === "") {
    console.log("YOUTUBE_API_KEY が未設定のためモックデータを使用します");
    const mockStreams = generateMockStreams(streamers, now);
    results = new Map(
      streamers.map((streamer) => [
        streamer.id,
        {
          ok: true as const,
          streams: mockStreams.filter(
            (stream) => stream.streamerId === streamer.id,
          ),
        },
      ]),
    );
  } else {
    results =
      options.fetchFn === undefined
        ? await fetchStreams(streamers, apiKey)
        : await fetchStreams(streamers, apiKey, options.fetchFn);
  }

  const failures = streamers.filter(
    (streamer) => results.get(streamer.id)?.ok !== true,
  );
  for (const streamer of failures) {
    const result = results.get(streamer.id);
    const message =
      result?.ok === false
        ? result.error.message
        : "取得結果がありません";
    console.error(`配信者 ${streamer.id} の取得に失敗しました: ${message}`);
  }
  if (failures.length === streamers.length) {
    throw new Error("全配信者の取得に失敗したため generated を更新しません");
  }

  const previousStreams =
    failures.length === 0
      ? []
      : await loadPreviousStreams(
          resolve(rootDir, "data/generated/streams.json"),
        );
  const merged = mergeFetchResults(streamers, results, previousStreams);
  const streams = filterStreams(merged.streams, now);
  const updatedAt = now.toISOString();

  await writeGeneratedFiles(
    {
      streams: resolve(rootDir, "data/generated/streams.json"),
      streamers: resolve(rootDir, "data/generated/streamers.json"),
    },
    { updatedAt, streams },
    { updatedAt, streamers },
    options.beforeCommit,
  );
}

function isCommandLineEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isCommandLineEntry()) {
  loadEnvFile(resolve(process.cwd(), ".env"))
    .then(() => runUpdate())
    .then(() => {
      console.log("generated データを更新しました");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`更新に失敗しました: ${message}`);
      process.exitCode = 1;
    });
}
