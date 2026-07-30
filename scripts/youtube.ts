import type { Stream, Streamer } from "./models.js";

export type FetchResult =
  | { ok: true; streams: Stream[] }
  | { ok: false; error: Error };

interface ChannelSource {
  streamer: Streamer;
  uploadsId: string;
  videoIds: string[];
}

interface VideoItem {
  id: string;
  snippet: {
    title: string;
    thumbnails?: Record<string, unknown>;
  };
  liveStreamingDetails?: Record<string, unknown>;
}

const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const CHANNEL_BATCH_SIZE = 50;
const VIDEO_BATCH_SIZE = 50;
const PLAYLIST_ITEM_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

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
  const operation = `${endpoint}.list`;
  let response: Response;
  let body: string;
  try {
    response = await fetchFn(`${API_BASE_URL}/${endpoint}?${query.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error: unknown) {
    throw new Error(
      `YouTube API ${operation} のリクエストに失敗しました: ${errorMessage(error, apiKey)}`,
    );
  }

  if (!response.ok) {
    const summary = body.replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `YouTube API ${operation} が HTTP ${response.status} を返しました${summary === "" ? "" : `: ${errorMessage(summary, apiKey)}`}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`YouTube API ${operation} のレスポンスが不正な JSON です`);
  }
  if (!isRecord(value)) {
    throw new Error(`YouTube API ${operation} のレスポンス構造が不正です`);
  }
  return value;
}

function requireItems(
  response: Record<string, unknown>,
  endpoint: string,
): unknown[] {
  if (!Array.isArray(response.items)) {
    throw new Error(`YouTube API ${endpoint} のレスポンスに items がありません`);
  }
  return response.items;
}

function parseChannelUploads(
  response: Record<string, unknown>,
): Map<string, string | undefined> {
  const uploadsByChannel = new Map<string, string | undefined>();
  for (const value of requireItems(response, "channels.list")) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !isRecord(value.snippet) ||
      typeof value.snippet.title !== "string"
    ) {
      throw new Error("YouTube API channels.list の channel item が不正です");
    }
    const contentDetails = value.contentDetails;
    const relatedPlaylists =
      isRecord(contentDetails) ? contentDetails.relatedPlaylists : undefined;
    const uploads =
      isRecord(relatedPlaylists) &&
      typeof relatedPlaylists.uploads === "string" &&
      relatedPlaylists.uploads !== ""
        ? relatedPlaylists.uploads
        : undefined;
    uploadsByChannel.set(value.id, uploads);
  }
  return uploadsByChannel;
}

function parsePlaylistVideoIds(response: Record<string, unknown>): string[] {
  return requireItems(response, "playlistItems.list").map((value) => {
    if (!isRecord(value)) {
      throw new Error("YouTube API playlistItems.list の item が不正です");
    }
    const details = value.contentDetails;
    if (
      !isRecord(details) ||
      typeof details.videoId !== "string" ||
      details.videoId === ""
    ) {
      throw new Error(
        "YouTube API playlistItems.list の item に videoId がありません",
      );
    }
    return details.videoId;
  });
}

function parseVideoItems(response: Record<string, unknown>): VideoItem[] {
  return requireItems(response, "videos.list").map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      value.id === "" ||
      !isRecord(value.snippet) ||
      typeof value.snippet.title !== "string"
    ) {
      throw new Error("YouTube API videos.list の video item が不正です");
    }
    if (
      value.liveStreamingDetails !== undefined &&
      !isRecord(value.liveStreamingDetails)
    ) {
      throw new Error(
        "YouTube API videos.list の liveStreamingDetails が不正です",
      );
    }
    return {
      id: value.id,
      snippet: {
        title: value.snippet.title,
        ...(value.snippet.thumbnails === undefined
          ? {}
          : { thumbnails: isRecord(value.snippet.thumbnails) ? value.snippet.thumbnails : {} }),
      },
      ...(value.liveStreamingDetails === undefined
        ? {}
        : { liveStreamingDetails: value.liveStreamingDetails }),
    };
  });
}

function optionalDate(
  details: Record<string, unknown>,
  field: string,
): string | undefined | null {
  const value = details[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    return null;
  }
  return value;
}

function thumbnailUrl(
  thumbnails: Record<string, unknown> | undefined,
): string | undefined {
  for (const quality of ["high", "medium", "default"]) {
    const thumbnail = thumbnails?.[quality];
    if (
      isRecord(thumbnail) &&
      typeof thumbnail.url === "string" &&
      thumbnail.url !== ""
    ) {
      return thumbnail.url;
    }
  }
  return undefined;
}

function convertVideo(video: VideoItem, streamerId: string): Stream | undefined {
  const details = video.liveStreamingDetails;
  if (details === undefined) {
    return undefined;
  }

  const scheduledStart = optionalDate(details, "scheduledStartTime");
  const actualStart = optionalDate(details, "actualStartTime");
  const actualEnd = optionalDate(details, "actualEndTime");
  if (
    scheduledStart === null ||
    actualStart === null ||
    actualEnd === null
  ) {
    console.warn(`動画 ${video.id} は日時が不正なため除外します`);
    return undefined;
  }

  const status =
    actualEnd !== undefined
      ? "ended"
      : actualStart !== undefined
        ? "live"
        : "upcoming";
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
    streamerId,
    title: video.snippet.title,
    thumbnail,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    status,
    ...(scheduledStart === undefined ? {} : { scheduledStart }),
    ...(actualStart === undefined ? {} : { actualStart }),
    ...(actualEnd === undefined ? {} : { actualEnd }),
  };
  if (status === "live" && details.concurrentViewers !== undefined) {
    const viewers = Number(details.concurrentViewers);
    if (Number.isFinite(viewers) && viewers >= 0) {
      stream.viewers = viewers;
    }
  }
  return stream;
}

export function filterStreams(streams: Stream[], now: Date): Stream[] {
  const nowTime = now.getTime();
  if (Number.isNaN(nowTime)) {
    throw new Error("now は有効な日時で指定してください");
  }
  const endedBoundary = nowTime - DAY_MS;
  const upcomingStart = nowTime - 7 * DAY_MS;
  const upcomingEnd = nowTime + 30 * DAY_MS;

  return streams.filter((stream) => {
    if (stream.status === "live") {
      return true;
    }
    if (stream.status === "ended") {
      const actualEnd =
        stream.actualEnd === undefined
          ? Number.NaN
          : new Date(stream.actualEnd).getTime();
      return !Number.isNaN(actualEnd) && actualEnd >= endedBoundary;
    }
    const scheduledStart =
      stream.scheduledStart === undefined
        ? Number.NaN
        : new Date(stream.scheduledStart).getTime();
    return (
      !Number.isNaN(scheduledStart) &&
      scheduledStart >= upcomingStart &&
      scheduledStart <= upcomingEnd
    );
  });
}

export async function fetchStreams(
  streamers: Streamer[],
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, FetchResult>> {
  const results = new Map<string, FetchResult>();
  const sources = new Map<string, ChannelSource>();

  const fail = (streamerIds: Iterable<string>, error: unknown): void => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    for (const streamerId of streamerIds) {
      results.set(streamerId, { ok: false, error: normalized });
      sources.delete(streamerId);
    }
  };

  for (const batch of chunks(streamers, CHANNEL_BATCH_SIZE)) {
    try {
      const response = await requestJson(
        "channels",
        {
          part: "snippet,contentDetails",
          id: batch.map((streamer) => streamer.youtubeChannelId).join(","),
          maxResults: String(CHANNEL_BATCH_SIZE),
        },
        apiKey,
        fetchFn,
      );
      const uploadsByChannel = parseChannelUploads(response);
      for (const streamer of batch) {
        if (!uploadsByChannel.has(streamer.youtubeChannelId)) {
          fail(
            [streamer.id],
            new Error(
              `チャンネルが見つかりません: ${streamer.youtubeChannelId}`,
            ),
          );
          continue;
        }
        const uploadsId = uploadsByChannel.get(streamer.youtubeChannelId);
        if (uploadsId === undefined) {
          fail(
            [streamer.id],
            new Error(
              `チャンネルに uploads プレイリストがありません: ${streamer.youtubeChannelId}`,
            ),
          );
          continue;
        }
        sources.set(streamer.id, { streamer, uploadsId, videoIds: [] });
      }
    } catch (error: unknown) {
      fail(
        batch.map((streamer) => streamer.id),
        error,
      );
    }
  }

  for (const source of [...sources.values()]) {
    try {
      const response = await requestJson(
        "playlistItems",
        {
          part: "contentDetails",
          playlistId: source.uploadsId,
          maxResults: String(PLAYLIST_ITEM_LIMIT),
        },
        apiKey,
        fetchFn,
      );
      source.videoIds = parsePlaylistVideoIds(response);
    } catch (error: unknown) {
      fail([source.streamer.id], error);
    }
  }

  const ownersByVideo = new Map<string, Set<string>>();
  for (const source of sources.values()) {
    for (const videoId of source.videoIds) {
      const owners = ownersByVideo.get(videoId) ?? new Set<string>();
      owners.add(source.streamer.id);
      ownersByVideo.set(videoId, owners);
    }
  }

  const streamsByStreamer = new Map<string, Stream[]>();
  for (const streamerId of sources.keys()) {
    streamsByStreamer.set(streamerId, []);
  }

  for (const videoIds of chunks([...ownersByVideo.keys()], VIDEO_BATCH_SIZE)) {
    const affectedStreamerIds = new Set(
      videoIds.flatMap((videoId) => [...(ownersByVideo.get(videoId) ?? [])]),
    );
    try {
      const response = await requestJson(
        "videos",
        {
          part: "snippet,liveStreamingDetails",
          id: videoIds.join(","),
          maxResults: String(VIDEO_BATCH_SIZE),
        },
        apiKey,
        fetchFn,
      );
      const videos = parseVideoItems(response);
      const returnedIds = new Set(videos.map((video) => video.id));
      for (const videoId of videoIds) {
        if (!returnedIds.has(videoId)) {
          console.warn(`動画 ${videoId} が見つからないため除外します`);
        }
      }
      for (const video of videos) {
        const owners = ownersByVideo.get(video.id);
        if (owners === undefined) {
          continue;
        }
        for (const streamerId of owners) {
          const stream = convertVideo(video, streamerId);
          if (stream !== undefined) {
            streamsByStreamer.get(streamerId)?.push(stream);
          }
        }
      }
    } catch (error: unknown) {
      fail(affectedStreamerIds, error);
    }
  }

  for (const streamer of streamers) {
    if (!results.has(streamer.id)) {
      results.set(streamer.id, {
        ok: true,
        streams: streamsByStreamer.get(streamer.id) ?? [],
      });
    }
  }
  return results;
}
