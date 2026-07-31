import type { Stream } from "./models.js";

export const VRCHAT_KEYWORDS = ["vrchat"] as const;

export interface ChannelInfo {
  id: string;
  name: string;
}

export interface DiscoveryResult {
  videoIds: Set<string>;
  successfulQueries: number;
  failedQueries: { eventType: string; error: Error }[];
  allSucceeded: boolean;
}

export type RefreshResult =
  | { ok: true; stream?: Stream; channel?: ChannelInfo }
  | { ok: false; error: Error };

interface VideoItem {
  id: string;
  snippet: {
    channelId: string;
    channelTitle: string;
    title: string;
    description: string;
    thumbnails?: Record<string, unknown>;
  };
  liveStreamingDetails?: Record<string, unknown>;
}

const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const VIDEO_BATCH_SIZE = 50;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENT_TYPES = ["live", "upcoming", "completed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function errorMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey === "" ? message : message.split(apiKey).join("[REDACTED]");
}

async function requestJson(
  endpoint: string,
  parameters: Record<string, string>,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ ...parameters, key: apiKey });
  let response: Response;
  let body: string;
  try {
    response = await fetchFn(`${API_BASE_URL}/${endpoint}?${query.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error: unknown) {
    throw new Error(
      `YouTube API ${endpoint}.list のリクエストに失敗しました: ${errorMessage(error, apiKey)}`,
    );
  }
  if (!response.ok) {
    const summary = body.replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `YouTube API ${endpoint}.list が HTTP ${response.status} を返しました${summary === "" ? "" : `: ${errorMessage(summary, apiKey)}`}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`YouTube API ${endpoint}.list のレスポンスが不正な JSON です`);
  }
  if (!isRecord(value)) {
    throw new Error(`YouTube API ${endpoint}.list のレスポンス構造が不正です`);
  }
  return value;
}

function requireItems(response: Record<string, unknown>, operation: string): unknown[] {
  if (!Array.isArray(response.items)) {
    throw new Error(`YouTube API ${operation} のレスポンスに items がありません`);
  }
  return response.items;
}

function parseSearchIds(response: Record<string, unknown>): string[] {
  const videoIds: string[] = [];
  for (const [index, value] of requireItems(response, "search.list").entries()) {
    const videoId = isRecord(value) && isRecord(value.id)
      ? value.id.videoId
      : undefined;
    if (typeof videoId !== "string" || videoId.trim() === "") {
      console.warn(
        `YouTube API search.list の item[${index}].id.videoId が不正なためスキップします`,
      );
      continue;
    }
    videoIds.push(videoId);
  }
  return videoIds;
}

function parseVideoItems(response: Record<string, unknown>): VideoItem[] {
  return requireItems(response, "videos.list").map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" || value.id === "" ||
      !isRecord(value.snippet) ||
      typeof value.snippet.channelId !== "string" || value.snippet.channelId === "" ||
      typeof value.snippet.channelTitle !== "string" || value.snippet.channelTitle === "" ||
      typeof value.snippet.title !== "string" ||
      typeof value.snippet.description !== "string"
    ) {
      throw new Error("YouTube API videos.list の video item が不正です");
    }
    if (value.liveStreamingDetails !== undefined && !isRecord(value.liveStreamingDetails)) {
      throw new Error("YouTube API videos.list の liveStreamingDetails が不正です");
    }
    return {
      id: value.id,
      snippet: {
        channelId: value.snippet.channelId,
        channelTitle: value.snippet.channelTitle,
        title: value.snippet.title,
        description: value.snippet.description,
        ...(isRecord(value.snippet.thumbnails) ? { thumbnails: value.snippet.thumbnails } : {}),
      },
      ...(value.liveStreamingDetails === undefined ? {} : { liveStreamingDetails: value.liveStreamingDetails }),
    };
  });
}

function optionalDate(
  details: Record<string, unknown>,
  field: string,
): string | undefined | null {
  const value = details[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

function thumbnailUrl(thumbnails: Record<string, unknown> | undefined): string | undefined {
  for (const quality of ["high", "medium", "default"]) {
    const thumbnail = thumbnails?.[quality];
    if (isRecord(thumbnail) && typeof thumbnail.url === "string" && thumbnail.url !== "") {
      return thumbnail.url;
    }
  }
  return undefined;
}

export function isVrchatContent(title: string, description: string): boolean {
  const text = `${title}\n${description}`.toLowerCase();
  return VRCHAT_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function isJapaneseContent(title: string, description: string): boolean {
  return /[ぁ-ゖァ-ヺｦ-ｯｱ-ﾝ]/.test(`${title}\n${description}`);
}

function convertVideo(video: VideoItem): { stream: Stream; channel: ChannelInfo } | undefined {
  if (!isVrchatContent(video.snippet.title, video.snippet.description)) return undefined;
  const details = video.liveStreamingDetails;
  if (details === undefined) return undefined;
  const scheduledStart = optionalDate(details, "scheduledStartTime");
  const actualStart = optionalDate(details, "actualStartTime");
  const actualEnd = optionalDate(details, "actualEndTime");
  if (scheduledStart === null || actualStart === null || actualEnd === null) {
    console.warn(`動画 ${video.id} は日時が不正なため除外します`);
    return undefined;
  }
  const status = actualEnd !== undefined ? "ended" : actualStart !== undefined ? "live" : "upcoming";
  if (status === "upcoming" && scheduledStart === undefined) {
    console.warn(`動画 ${video.id} は配信予定日時がないため除外します`);
    return undefined;
  }
  const thumbnail = thumbnailUrl(video.snippet.thumbnails);
  if (thumbnail === undefined) {
    console.warn(`動画 ${video.id} はサムネイルがないため除外します`);
    return undefined;
  }
  const stream: Stream = {
    id: video.id,
    streamerId: video.snippet.channelId,
    title: video.snippet.title,
    thumbnail,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    status,
    isJapanese: isJapaneseContent(video.snippet.title, video.snippet.description),
    ...(scheduledStart === undefined ? {} : { scheduledStart }),
    ...(actualStart === undefined ? {} : { actualStart }),
    ...(actualEnd === undefined ? {} : { actualEnd }),
  };
  if (status === "live" && details.concurrentViewers !== undefined) {
    const viewers = Number(details.concurrentViewers);
    if (Number.isFinite(viewers) && viewers >= 0) stream.viewers = viewers;
  }
  return { stream, channel: { id: video.snippet.channelId, name: video.snippet.channelTitle } };
}

export async function discoverVideoIds(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const videoIds = new Set<string>();
  const failedQueries: DiscoveryResult["failedQueries"] = [];
  let successfulQueries = 0;
  for (const eventType of EVENT_TYPES) {
    try {
      const response = await requestJson("search", {
        part: "id", q: "VRChat", type: "video", eventType,
        maxResults: "50", relevanceLanguage: "ja", order: "date",
      }, apiKey, fetchFn);
      for (const id of parseSearchIds(response)) videoIds.add(id);
      successfulQueries += 1;
    } catch (error: unknown) {
      failedQueries.push({
        eventType,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return { videoIds, successfulQueries, failedQueries, allSucceeded: successfulQueries === EVENT_TYPES.length };
}

export async function refreshStreams(
  videoIds: Iterable<string>,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, RefreshResult>> {
  const uniqueIds = [...new Set(videoIds)];
  const results = new Map<string, RefreshResult>();
  for (const batch of chunks(uniqueIds, VIDEO_BATCH_SIZE)) {
    try {
      const response = await requestJson("videos", {
        part: "snippet,liveStreamingDetails",
        id: batch.join(","),
        maxResults: String(VIDEO_BATCH_SIZE),
      }, apiKey, fetchFn);
      const items = parseVideoItems(response);
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const id of batch) {
        const item = byId.get(id);
        if (item === undefined) {
          results.set(id, { ok: true });
          continue;
        }
        const converted = convertVideo(item);
        results.set(id, converted === undefined ? { ok: true } : { ok: true, ...converted });
      }
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      for (const id of batch) results.set(id, { ok: false, error: normalized });
    }
  }
  return results;
}

export function filterStreams(streams: Stream[], now: Date): Stream[] {
  const nowTime = now.getTime();
  if (Number.isNaN(nowTime)) throw new Error("now は有効な日時で指定してください");
  const endedBoundary = nowTime - DAY_MS;
  const upcomingStart = nowTime - 7 * DAY_MS;
  const upcomingEnd = nowTime + 30 * DAY_MS;
  return streams.filter((stream) => {
    if (stream.status === "live") return true;
    if (stream.status === "ended") {
      const time = stream.actualEnd === undefined ? Number.NaN : new Date(stream.actualEnd).getTime();
      return !Number.isNaN(time) && time >= endedBoundary;
    }
    const time = stream.scheduledStart === undefined ? Number.NaN : new Date(stream.scheduledStart).getTime();
    return !Number.isNaN(time) && time >= upcomingStart && time <= upcomingEnd;
  });
}
