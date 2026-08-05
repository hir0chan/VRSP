import type { Stream, Streamer } from "./models.js";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const VRCHAT_GAME_ID = "499003";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REGULAR_PAGES = 3;
export const MAX_TWITCH_LIVE = 50;
export const EXCLUDE_MATURE = true;
export const NSFW_TITLE_PATTERNS = ["🔞", "+18", "18+", "nsfw", "r-18", "r18"] as const;

export interface TwitchItem {
  id: string;
  userId: string;
  userName: string;
  userLogin: string;
  title: string;
  thumbnailUrl: string;
  startedAt: string;
  language: string;
  viewerCount: number;
  isMature: boolean;
}

export interface TwitchLiveData {
  streams: Stream[];
  streamers: Streamer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret !== "") message = message.split(secret).join("[REDACTED]");
  }
  return message;
}

async function responseJson(
  response: Response,
  operation: string,
  secrets: string[],
): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) {
    const summary = redactedMessage(body.replace(/\s+/g, " ").slice(0, 500), secrets);
    throw new Error(`Twitch ${operation} が HTTP ${response.status} を返しました${summary === "" ? "" : `: ${summary}`}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Twitch ${operation} のレスポンスが不正な JSON です`);
  }
}

export async function fetchAppToken(
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const parameters = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  let response: Response;
  try {
    response = await fetchFn(`${TOKEN_URL}?${parameters.toString()}`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new Error(`Twitch トークン取得に失敗しました: ${redactedMessage(error, [clientSecret])}`);
  }
  const value = await responseJson(response, "トークン取得", [clientSecret]);
  if (!isRecord(value) || typeof value.access_token !== "string" || value.access_token === "") {
    throw new Error("Twitch トークン取得のレスポンス構造が不正です");
  }
  return value.access_token;
}

function parseItem(value: unknown, index: number): TwitchItem | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" || value.id === "" ||
    typeof value.user_id !== "string" || value.user_id === "" ||
    typeof value.user_name !== "string" || value.user_name === "" ||
    typeof value.user_login !== "string" || value.user_login === "" ||
    typeof value.title !== "string" ||
    typeof value.thumbnail_url !== "string" || value.thumbnail_url === "" ||
    typeof value.started_at !== "string" || Number.isNaN(new Date(value.started_at).getTime()) ||
    typeof value.language !== "string" || value.language === "" ||
    typeof value.is_mature !== "boolean"
  ) {
    console.warn(`Twitch Get Streams の item[${index}] は必須フィールドが不正なためスキップします`);
    return undefined;
  }
  if (!Number.isInteger(value.viewer_count) || (value.viewer_count as number) < 0) {
    console.warn(`Twitch Get Streams の item[${index}].viewer_count が不正なためスキップします`);
    return undefined;
  }
  if (
    !value.thumbnail_url.includes("{width}") ||
    !value.thumbnail_url.includes("{height}")
  ) {
    console.warn(`Twitch Get Streams の item[${index}].thumbnail_url にプレースホルダがないためスキップします`);
    return undefined;
  }
  const thumbnailUrl = value.thumbnail_url
    .replaceAll("{width}", "640")
    .replaceAll("{height}", "360");
  if (thumbnailUrl.includes("{width}") || thumbnailUrl.includes("{height}")) {
    console.warn(`Twitch Get Streams の item[${index}].thumbnail_url を変換できないためスキップします`);
    return undefined;
  }
  return {
    id: value.id,
    userId: value.user_id,
    userName: value.user_name,
    userLogin: value.user_login,
    title: value.title,
    thumbnailUrl,
    startedAt: value.started_at,
    language: value.language,
    viewerCount: value.viewer_count as number,
    isMature: value.is_mature,
  };
}

function parsePage(value: unknown): { items: TwitchItem[]; cursor?: string } {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.pagination)) {
    throw new Error("Twitch Get Streams のレスポンス構造が不正です");
  }
  const cursor = value.pagination.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
    throw new Error("Twitch Get Streams の pagination.cursor が不正です");
  }
  return {
    items: value.data.flatMap((item, index) => {
      const parsed = parseItem(item, index);
      return parsed === undefined ? [] : [parsed];
    }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function fetchStreamPages(
  clientId: string,
  accessToken: string,
  language: string | undefined,
  maxPages: number,
  fetchFn: typeof fetch,
): Promise<TwitchItem[]> {
  const items: TwitchItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ game_id: VRCHAT_GAME_ID, first: "100" });
    if (language !== undefined) query.set("language", language);
    if (cursor !== undefined) query.set("after", cursor);
    let response: Response;
    try {
      response = await fetchFn(`${STREAMS_URL}?${query.toString()}`, {
        headers: { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new Error(`Twitch Get Streams に失敗しました: ${redactedMessage(error, [accessToken])}`);
    }
    const value = await responseJson(response, "Get Streams", [accessToken]);
    const parsed = parsePage(value);
    items.push(...parsed.items);
    cursor = parsed.cursor;
    if (cursor === undefined) break;
  }
  return items;
}

export function selectTwitchItems(items: TwitchItem[]): TwitchItem[] {
  const unique = new Map<string, TwitchItem>();
  for (const item of items) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  const eligible = [...unique.values()].filter((item) => {
    if (!EXCLUDE_MATURE) return true;
    if (item.isMature) return false;
    const normalizedTitle = item.title.toLowerCase();
    return !NSFW_TITLE_PATTERNS.some((pattern) => normalizedTitle.includes(pattern));
  });
  const japanese = eligible.filter((item) => item.language === "ja");
  const nonJapanese = eligible
    .filter((item) => item.language !== "ja")
    .sort((a, b) => b.viewerCount - a.viewerCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_TWITCH_LIVE);
  const selected = new Map<string, TwitchItem>();
  for (const item of [...japanese, ...nonJapanese]) selected.set(item.id, item);
  return [...selected.values()];
}

function convertItems(items: TwitchItem[]): TwitchLiveData {
  const streams: Stream[] = [];
  const streamers = new Map<string, Streamer>();
  for (const item of items) {
    const streamerId = `tw-${item.userId}`;
    streams.push({
      id: `tw-${item.id}`,
      streamerId,
      title: item.title,
      thumbnail: item.thumbnailUrl,
      url: `https://www.twitch.tv/${item.userLogin}`,
      status: "live",
      actualStart: item.startedAt,
      viewers: item.viewerCount,
      isJapanese: item.language === "ja",
      platform: "twitch",
    });
    streamers.set(streamerId, {
      id: streamerId,
      name: item.userName,
      youtubeChannelId: streamerId,
      enabled: true,
    });
  }
  return { streams, streamers: [...streamers.values()] };
}

export async function fetchVrchatLiveStreams(
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch = fetch,
): Promise<TwitchLiveData> {
  const accessToken = await fetchAppToken(clientId, clientSecret, fetchFn);
  try {
    const regular = await fetchStreamPages(clientId, accessToken, undefined, MAX_REGULAR_PAGES, fetchFn);
    const japanese = await fetchStreamPages(clientId, accessToken, "ja", 1, fetchFn);
    return convertItems(selectTwitchItems([...regular, ...japanese]));
  } catch (error: unknown) {
    throw new Error(redactedMessage(error, [clientSecret, accessToken]));
  }
}
