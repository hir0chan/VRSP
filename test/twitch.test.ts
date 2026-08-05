import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Stream, Streamer } from "../scripts/models.js";
import {
  fetchAppToken,
  fetchVrchatLiveStreams,
  MAX_TWITCH_LIVE,
  NSFW_TITLE_PATTERNS,
  selectTwitchItems,
  type TwitchItem,
} from "../scripts/twitch.js";
import { isStream, runUpdate } from "../scripts/update.js";

const noopConsole = (): void => undefined;
console.warn = noopConsole;
console.error = noopConsole;
console.log = noopConsole;

const NOW = new Date("2026-08-05T09:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function twitchItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_id: `user-${id}`,
    user_name: `配信者 ${id}`,
    user_login: `login_${id}`,
    game_id: "499003",
    type: "live",
    title: `VRChat ${id}`,
    viewer_count: 10,
    started_at: "2026-08-05T08:00:00.000Z",
    language: "en",
    thumbnail_url: "https://example.com/{width}x{height}.jpg",
    is_mature: false,
    ...overrides,
  };
}

function rawItem(id: string, overrides: Partial<TwitchItem> = {}): TwitchItem {
  return {
    id,
    userId: `user-${id}`,
    userName: id,
    userLogin: id,
    title: id,
    thumbnailUrl: "https://example.com/640x360.jpg",
    startedAt: NOW.toISOString(),
    language: "en",
    viewerCount: 1,
    isMature: false,
    ...overrides,
  };
}

function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return handler(url, init);
  }) as typeof fetch;
}

function twitchAndYoutubeFetch(options: {
  twitchItems?: unknown[];
  youtubeItems?: unknown[];
  failTwitch?: boolean;
  failYoutubeRefresh?: boolean;
} = {}): typeof fetch {
  return mockFetch((url) => {
    if (url.hostname === "id.twitch.tv") return json({ access_token: "test-token" });
    if (url.hostname === "api.twitch.tv") {
      return options.failTwitch ? json({ error: "failed" }, 503) : json({ data: options.twitchItems ?? [], pagination: {} });
    }
    if (url.pathname.endsWith("/search")) return json({ items: [] });
    if (url.pathname.endsWith("/videos")) {
      return options.failYoutubeRefresh ? json({}, 503) : json({ items: options.youtubeItems ?? [] });
    }
    throw new Error(`unexpected URL: ${url.origin}${url.pathname}`);
  });
}

function youtubeVideo(id: string): unknown {
  return {
    id,
    snippet: {
      channelId: `UC_${id}`,
      channelTitle: `YouTube ${id}`,
      title: `VRChat ${id}`,
      description: "",
      thumbnails: { high: { url: `https://example.com/${id}.jpg` } },
    },
    liveStreamingDetails: { actualStartTime: NOW.toISOString() },
  };
}

function youtubeStream(id: string): Stream {
  return {
    id,
    streamerId: `UC_${id}`,
    title: id,
    thumbnail: `https://example.com/${id}.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    status: "live",
  };
}

async function prepareRoot(options: {
  tracked?: Stream[];
  streamers?: Streamer[];
  discovery?: unknown;
} = {}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-twitch-"));
  const generated = resolve(root, "data/generated");
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(root, "data/blocklist.yaml"), "[]\n");
  if (options.tracked !== undefined) {
    await writeFile(resolve(generated, "streams.json"), JSON.stringify({
      updatedAt: NOW.toISOString(), tracked: options.tracked, streams: options.tracked,
    }));
  }
  if (options.streamers !== undefined) {
    await writeFile(resolve(generated, "streamers.json"), JSON.stringify({ updatedAt: NOW.toISOString(), streamers: options.streamers }));
  }
  if (options.discovery !== undefined) {
    await writeFile(resolve(generated, "discovery.json"), JSON.stringify(options.discovery));
  }
  return root;
}

async function outputs(root: string): Promise<{ streams: { tracked: Stream[]; streams: Stream[] }; streamers: Streamer[] }> {
  const streams = JSON.parse(await readFile(resolve(root, "data/generated/streams.json"), "utf8")) as { tracked: Stream[]; streams: Stream[] };
  const streamerPayload = JSON.parse(await readFile(resolve(root, "data/generated/streamers.json"), "utf8")) as { streamers: Streamer[] };
  return { streams, streamers: streamerPayload.streamers };
}

test("トークンを毎回 POST で取得し、失敗エラーに secret を露出しない", async () => {
  let method: string | undefined;
  const first = await fetchAppToken("client", "top-secret", mockFetch((url, init) => {
    method = init?.method;
    assert.equal(url.searchParams.get("grant_type"), "client_credentials");
    return json({ access_token: "token-a" });
  }));
  assert.equal(first, "token-a");
  assert.equal(method, "POST");

  const error = await fetchAppToken("client", "top-secret", mockFetch((url) => json({ detail: url.toString() }, 401)))
    .then(() => undefined, (reason: unknown) => reason);
  assert.equal(error instanceof Error, true);
  assert.equal(String(error).includes("top-secret"), false);
});

test("通常3ページと ja 1ページを取得し、cursor 停止と2系統の ID 重複排除を行う", async () => {
  const calls: URL[] = [];
  const result = await fetchVrchatLiveStreams("client", "secret", mockFetch((url, init) => {
    if (url.hostname === "id.twitch.tv") return json({ access_token: "access-token" });
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("Client-Id"), "client");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer access-token");
    const language = url.searchParams.get("language");
    const after = url.searchParams.get("after");
    if (language === "ja") return json({ data: [twitchItem("shared", { language: "ja" }), twitchItem("ja-only", { language: "ja" })], pagination: {} });
    if (after === null) return json({ data: [twitchItem("first"), twitchItem("shared", { language: "ja" })], pagination: { cursor: "next-1" } });
    if (after === "next-1") return json({ data: [twitchItem("second")], pagination: { cursor: "next-2" } });
    return json({ data: [twitchItem("third")], pagination: { cursor: "ignored-after-limit" } });
  }));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((url) => url.searchParams.get("after")), [null, "next-1", "next-2", null]);
  assert.equal(result.streams.filter((stream) => stream.id === "tw-shared").length, 1);
  assert.deepEqual(new Set(result.streams.map((stream) => stream.id)), new Set(["tw-first", "tw-shared", "tw-second", "tw-third", "tw-ja-only"]));

  let streamCalls = 0;
  await fetchVrchatLiveStreams("client", "secret", mockFetch((url) => {
    if (url.hostname === "id.twitch.tv") return json({ access_token: "token" });
    streamCalls += 1;
    return json({ data: [], pagination: {} });
  }));
  assert.equal(streamCalls, 2);
});

test("片方のクエリ失敗・タイムアウトを Twitch 全体の失敗とし token を露出しない", async () => {
  const failed = fetchVrchatLiveStreams("client", "secret-value", mockFetch((url) => {
    if (url.hostname === "id.twitch.tv") return json({ access_token: "private-token" });
    if (url.searchParams.get("language") === "ja") return json({ token: "private-token" }, 500);
    return json({ data: [], pagination: {} });
  }));
  const error = await failed.then(() => undefined, (reason: unknown) => reason);
  assert.equal(error instanceof Error, true);
  assert.equal(String(error).includes("private-token"), false);
  assert.equal(String(error).includes("secret-value"), false);

  const originalTimeout = AbortSignal.timeout;
  const timeoutValues: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    timeoutValues.push(milliseconds);
    return originalTimeout(milliseconds);
  });
  try {
    await assert.rejects(fetchAppToken("client", "secret", mockFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    })), /失敗/);
    assert.deepEqual(timeoutValues, [15_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("mature を除外し、ja 全件と非 ja 上位50件を同数時 ID 昇順で選ぶ", () => {
  const japanese = [rawItem("ja-a", { language: "ja" }), rawItem("ja-b", { language: "ja" })];
  const nonJapanese = Array.from({ length: MAX_TWITCH_LIVE + 2 }, (_, index) => rawItem(
    `non-${String(index).padStart(2, "0")}`,
    { viewerCount: index === 0 || index === 1 ? 500 : index },
  ));
  const result = selectTwitchItems([...japanese, ...nonJapanese, rawItem("adult", { isMature: true, viewerCount: 9_999 })]);
  assert.equal(result.filter((item) => item.language === "ja").length, 2);
  assert.equal(result.filter((item) => item.language !== "ja").length, MAX_TWITCH_LIVE);
  assert.equal(result.some((item) => item.id === "adult"), false);
  const tied = result.filter((item) => item.viewerCount === 500);
  assert.deepEqual(tied.map((item) => item.id), ["non-00", "non-01"]);
});

test("タイトルの明示的 NSFW マーカーだけを大文字小文字を問わず除外する", () => {
  const marked = NSFW_TITLE_PATTERNS.map((pattern, index) => rawItem(
    `marked-${index}`,
    { title: `VRChat ${pattern.toUpperCase()} stream` },
  ));
  const safe = [
    rawItem("number-only", { title: "VRChat 18 worlds tour" }),
    rawItem("ordinary", { title: "VRChat world hopping + friends" }),
  ];
  const result = selectTwitchItems([...marked, ...safe]);
  assert.deepEqual(result.map((item) => item.id), ["number-only", "ordinary"]);
});

test("変換は platform・言語・サムネ・viewer を設定し、個別不正 item は warn 除外する", async () => {
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const result = await fetchVrchatLiveStreams("client", "secret", mockFetch((url) => {
      if (url.hostname === "id.twitch.tv") return json({ access_token: "token" });
      if (url.searchParams.get("language") === "ja") return json({ data: [], pagination: {} });
      return json({ data: [
        twitchItem("valid", { language: "ja", viewer_count: 42 }),
        twitchItem("no-placeholder", { thumbnail_url: "https://example.com/image.jpg" }),
        twitchItem("bad-viewers", { viewer_count: -1 }),
        { id: "missing" },
      ], pagination: {} });
    }));
    assert.equal(result.streams.length, 1);
    assert.deepEqual(result.streams[0], {
      id: "tw-valid",
      streamerId: "tw-user-valid",
      title: "VRChat valid",
      thumbnail: "https://example.com/640x360.jpg",
      url: "https://www.twitch.tv/login_valid",
      status: "live",
      actualStart: "2026-08-05T08:00:00.000Z",
      viewers: 42,
      isJapanese: true,
      platform: "twitch",
    });
    assert.equal(warnings.length, 3);
  } finally {
    console.warn = noopConsole;
  }

  await assert.rejects(fetchVrchatLiveStreams("client", "secret", mockFetch((url) =>
    url.hostname === "id.twitch.tv" ? json({ access_token: "token" }) : json({ data: [] }),
  )), /構造/);
});

test("認証情報欠落時は Twitch を呼ばず YouTube のみ更新する", async () => {
  const existing = youtubeStream("known");
  const root = await prepareRoot({ tracked: [existing], streamers: [{ id: existing.streamerId, name: "known", youtubeChannelId: existing.streamerId, enabled: true }] });
  let twitchCalls = 0;
  const fetchFn = mockFetch((url) => {
    if (url.hostname.endsWith("twitch.tv")) twitchCalls += 1;
    if (url.pathname.endsWith("/search")) return json({ items: [] });
    return json({ items: [youtubeVideo("known")] });
  });
  await runUpdate({ rootDir: root, now: NOW, apiKey: "youtube-key", twitchClientId: "", twitchClientSecret: "", fetchFn });
  assert.equal(twitchCalls, 0);
  assert.deepEqual((await outputs(root)).streams.streams.map((stream) => stream.id), ["known"]);
});

test("制御フロー① YouTube 通常書込へ Twitch と対応 streamer をマージする", async () => {
  const existing = youtubeStream("known");
  const root = await prepareRoot({ tracked: [existing], streamers: [{ id: existing.streamerId, name: "known", youtubeChannelId: existing.streamerId, enabled: true }] });
  await runUpdate({
    rootDir: root, now: NOW, apiKey: "youtube", twitchClientId: "client", twitchClientSecret: "secret",
    fetchFn: twitchAndYoutubeFetch({ twitchItems: [twitchItem("twitch")], youtubeItems: [youtubeVideo("known")] }),
  });
  const output = await outputs(root);
  assert.deepEqual(output.streams.tracked.map((stream) => stream.id), ["known"]);
  assert.deepEqual(new Set(output.streams.streams.map((stream) => stream.id)), new Set(["known", "tw-twitch"]));
  assert.equal(output.streamers.some((streamer) => streamer.id === "tw-user-twitch"), true);
  assert.equal(output.streams.streams.every((stream) => output.streamers.some((streamer) => streamer.id === stream.streamerId)), true);
});

test("制御フロー② 追跡0・discovery成功0件では Twitch のみ書き込む", async () => {
  const root = await prepareRoot();
  await runUpdate({
    rootDir: root, now: NOW, apiKey: "youtube", twitchClientId: "client", twitchClientSecret: "secret",
    fetchFn: twitchAndYoutubeFetch({ twitchItems: [twitchItem("only")] }),
  });
  const output = await outputs(root);
  assert.deepEqual(output.streams.tracked, []);
  assert.deepEqual(output.streams.streams.map((stream) => stream.id), ["tw-only"]);
});

test("制御フロー③ 追跡0・クールダウン中は Twitch 成功時だけ書き込む", async () => {
  const discovery = { discoveryAttemptedAt: NOW.toISOString() };
  const successRoot = await prepareRoot({ discovery });
  await runUpdate({
    rootDir: successRoot, now: NOW, apiKey: "youtube", twitchClientId: "client", twitchClientSecret: "secret",
    fetchFn: twitchAndYoutubeFetch({ twitchItems: [twitchItem("cooldown")] }),
  });
  assert.deepEqual((await outputs(successRoot)).streams.streams.map((stream) => stream.id), ["tw-cooldown"]);

  const failedRoot = await prepareRoot({ discovery });
  await runUpdate({
    rootDir: failedRoot, now: NOW, apiKey: "youtube", twitchClientId: "client", twitchClientSecret: "secret",
    fetchFn: twitchAndYoutubeFetch({ failTwitch: true }),
  });
  await assert.rejects(readFile(resolve(failedRoot, "data/generated/streams.json"), "utf8"), /ENOENT/);
});

test("制御フロー④ YouTube 全 refresh 失敗時は Twitch があっても既存を変更しない", async () => {
  const existing = youtubeStream("keep");
  const root = await prepareRoot({ tracked: [existing], streamers: [{ id: existing.streamerId, name: "keep", youtubeChannelId: existing.streamerId, enabled: true }] });
  const streamsPath = resolve(root, "data/generated/streams.json");
  const streamersPath = resolve(root, "data/generated/streamers.json");
  const beforeStreams = await readFile(streamsPath, "utf8");
  const beforeStreamers = await readFile(streamersPath, "utf8");
  await assert.rejects(runUpdate({
    rootDir: root, now: NOW, apiKey: "youtube", twitchClientId: "client", twitchClientSecret: "secret",
    fetchFn: twitchAndYoutubeFetch({ twitchItems: [twitchItem("ignored")], failYoutubeRefresh: true }),
  }), /全 refresh/);
  assert.equal(await readFile(streamsPath, "utf8"), beforeStreams);
  assert.equal(await readFile(streamersPath, "utf8"), beforeStreamers);
});

test("isStream は platform 欠落を YouTube として許容し、有効値のみ受理する", () => {
  const legacy = youtubeStream("legacy");
  assert.equal(isStream(legacy), true);
  assert.equal(isStream({ ...legacy, platform: "youtube" }), true);
  assert.equal(isStream({ ...legacy, platform: "twitch" }), true);
  assert.equal(isStream({ ...legacy, platform: "niconico" }), true);
  assert.equal(isStream({ ...legacy, platform: "other" }), false);
});
