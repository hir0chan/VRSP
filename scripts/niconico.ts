import type { Stream, Streamer } from "./models.js";
import { NSFW_TITLE_PATTERNS } from "./twitch.js";

const SEARCH_URL = "https://live.nicovideo.jp/search";
const REQUEST_TIMEOUT_MS = 15_000;
const UPCOMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_AGENT = "Mozilla/5.0 (compatible; VRSP/1.0; +https://github.com/hir0chan/VRSP)";

export interface NiconicoProgram {
  title: string;
  description: string;
  listingThumbnail: string;
  watchPageUrl: string;
  nicoliveProgramId: string;
  beginTime: number;
  status: string;
  payment: boolean;
  isFollowerOnly: boolean;
  supplier: {
    name: string;
    programProviderId: string;
  };
}

export interface NiconicoLiveData {
  streams: Stream[];
  streamers: Streamer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/g, (entity) => {
    const named: Record<string, string> = {
      "&quot;": "\"",
      "&apos;": "'",
      "&#39;": "'",
      "&lt;": "<",
      "&gt;": ">",
      "&amp;": "&",
    };
    const normalized = entity.toLowerCase();
    const replacement = named[normalized];
    if (replacement !== undefined) return replacement;
    if (!normalized.startsWith("&#")) {
      throw new Error(`embedded-data に未対応の HTML エンティティがあります: ${entity}`);
    }
    const hexadecimal = normalized.startsWith("&#x");
    const source = entity.slice(hexadecimal ? 3 : 2, -1);
    const codePoint = Number.parseInt(source, hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new Error(`embedded-data に不正な HTML エンティティがあります: ${entity}`);
    }
    return String.fromCodePoint(codePoint);
  });
}

export function extractEmbeddedData(html: string): unknown {
  const values: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const openingTag = match[0];
    const attributes = new Map<string, string>();
    for (const attribute of openingTag.matchAll(/(?:^|\s)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = attribute[1];
      const value = attribute[2] ?? attribute[3];
      if (name !== undefined && value !== undefined) attributes.set(name.toLowerCase(), value);
    }
    if (attributes.get("id") === "embedded-data") {
      const dataProps = attributes.get("data-props");
      if (dataProps === undefined) throw new Error("embedded-data に data-props がありません");
      values.push(dataProps);
    }
  }
  if (values.length !== 1) {
    throw new Error(`embedded-data は1件である必要があります: ${values.length}件`);
  }
  try {
    return JSON.parse(decodeHtmlEntities(values[0] ?? "")) as unknown;
  } catch (error: unknown) {
    throw new Error(`embedded-data を復号または JSON.parse できません: ${redactedMessage(error)}`);
  }
}

export function parseProgram(value: unknown, index: number): NiconicoProgram | undefined {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.listingThumbnail !== "string" || value.listingThumbnail === "" ||
    typeof value.watchPageUrl !== "string" || value.watchPageUrl === "" ||
    typeof value.nicoliveProgramId !== "string" || value.nicoliveProgramId === "" ||
    typeof value.status !== "string" ||
    typeof value.payment !== "boolean" ||
    typeof value.isFollowerOnly !== "boolean" ||
    !isRecord(value.supplier) ||
    typeof value.supplier.name !== "string" || value.supplier.name === "" ||
    typeof value.supplier.programProviderId !== "string" || value.supplier.programProviderId === ""
  ) {
    console.warn(`ニコニコ生放送検索の program[${index}] は必須フィールドが不正なためスキップします`);
    return undefined;
  }
  if (!Number.isInteger(value.beginTime) || (value.beginTime as number) <= 0) {
    console.warn(`ニコニコ生放送検索の program[${index}].beginTime が不正なためスキップします`);
    return undefined;
  }
  const beginTime = value.beginTime as number;
  if (Number.isNaN(new Date(beginTime * 1_000).getTime())) {
    console.warn(`ニコニコ生放送検索の program[${index}].beginTime が範囲外のためスキップします`);
    return undefined;
  }
  return {
    title: value.title,
    description: value.description,
    listingThumbnail: value.listingThumbnail,
    watchPageUrl: value.watchPageUrl,
    nicoliveProgramId: value.nicoliveProgramId,
    beginTime,
    status: value.status,
    payment: value.payment,
    isFollowerOnly: value.isFollowerOnly,
    supplier: {
      name: value.supplier.name,
      programProviderId: value.supplier.programProviderId,
    },
  };
}

function parsePage(value: unknown, status: "onair" | "reserved"): NiconicoProgram[] {
  if (!isRecord(value) || !isRecord(value.searchResult) || !isRecord(value.searchResult.statusData)) {
    throw new Error(`ニコニコ生放送検索(${status})のルート構造が不正です`);
  }
  const page = value.searchResult.statusData[status];
  if (!isRecord(page) || !Array.isArray(page.programs) || !Number.isInteger(page.totalCount) || (page.totalCount as number) < 0) {
    throw new Error(`ニコニコ生放送検索(${status})の結果構造が不正です`);
  }
  if ((page.totalCount as number) > page.programs.length) {
    console.warn(`ニコニコ生放送検索(${status})は全件を取得できていません: ${page.programs.length}/${String(page.totalCount)}件`);
  }
  return page.programs.flatMap((program, index) => {
    const parsed = parseProgram(program, index);
    return parsed === undefined ? [] : [parsed];
  });
}

export function convertPrograms(
  onair: NiconicoProgram[],
  reserved: NiconicoProgram[],
  now: Date,
  blockedIds: Set<string>,
): NiconicoLiveData {
  if (Number.isNaN(now.getTime())) throw new Error("now は有効な日時で指定してください");
  const programs = new Map<string, NiconicoProgram>();
  for (const program of onair) programs.set(program.nicoliveProgramId, program);
  for (const program of reserved) {
    if (!programs.has(program.nicoliveProgramId)) programs.set(program.nicoliveProgramId, program);
  }

  const streams: Stream[] = [];
  const streamers = new Map<string, Streamer>();
  for (const program of programs.values()) {
    const streamerId = `nico-${program.supplier.programProviderId}`;
    const normalizedTitle = program.title.toLowerCase();
    if (
      blockedIds.has(streamerId) ||
      program.payment ||
      program.isFollowerOnly ||
      NSFW_TITLE_PATTERNS.some((pattern) => normalizedTitle.includes(pattern))
    ) continue;

    const start = new Date(program.beginTime * 1_000);
    const status = program.status === "ON_AIR" ? "live" : program.status === "RELEASED" ? "upcoming" : undefined;
    if (status === undefined || Number.isNaN(start.getTime())) continue;
    if (status === "upcoming" && start.getTime() > now.getTime() + UPCOMING_WINDOW_MS) continue;

    streams.push({
      id: `nico-${program.nicoliveProgramId}`,
      streamerId,
      title: program.title,
      thumbnail: program.listingThumbnail,
      url: program.watchPageUrl,
      status,
      ...(status === "live" ? { actualStart: start.toISOString() } : { scheduledStart: start.toISOString() }),
      isJapanese: true,
      platform: "niconico",
    });
    streamers.set(streamerId, {
      id: streamerId,
      name: program.supplier.name,
      youtubeChannelId: streamerId,
      enabled: true,
    });
  }
  return { streams, streamers: [...streamers.values()] };
}

async function fetchPage(status: "onair" | "reserved", fetchFn: typeof fetch): Promise<NiconicoProgram[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keyword", "VRChat");
  url.searchParams.set("status", status);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new Error(`ニコニコ生放送検索(${status})に失敗しました: ${redactedMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`ニコニコ生放送検索(${status})が HTTP ${response.status} を返しました`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`ニコニコ生放送検索(${status})の Content-Type が不正です: ${contentType || "なし"}`);
  }
  return parsePage(extractEmbeddedData(await response.text()), status);
}

export async function fetchVrchatNiconicoStreams(
  blockedIds: Set<string>,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<NiconicoLiveData> {
  const [onair, reserved] = await Promise.all([
    fetchPage("onair", fetchFn),
    fetchPage("reserved", fetchFn),
  ]);
  return convertPrograms(onair, reserved, now, blockedIds);
}
