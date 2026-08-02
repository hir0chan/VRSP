import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Stream, Streamer } from "../scripts/models.js";
import {
  limitTracked,
  loadEnvFile,
  runUpdate,
  isStream,
  shouldDiscover,
  validateBlocklist,
} from "../scripts/update.js";
import {
  discoverVideoIds,
  filterStreams,
  isJapaneseContent,
  isVrchatContent,
  refreshStreams,
} from "../scripts/youtube.js";

const noopConsole = (): void => undefined;
console.warn = noopConsole;
console.error = noopConsole;
console.log = noopConsole;

const NOW = new Date("2026-07-30T12:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function mockFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return handler(url);
  }) as typeof fetch;
}

function video(
  id: string,
  options: {
    channelId?: string;
    title?: string;
    description?: string;
    details?: Record<string, unknown> | null;
  } = {},
): unknown {
  const details = options.details === undefined
    ? { scheduledStartTime: "2026-07-31T12:00:00.000Z" }
    : options.details;
  return {
    id,
    snippet: {
      channelId: options.channelId ?? `UC_${id}`,
      channelTitle: `配信者 ${id}`,
      title: options.title ?? `VRChat 配信 ${id}`,
      description: options.description ?? "",
      thumbnails: { high: { url: `https://example.com/${id}.jpg` } },
    },
    ...(details === null ? {} : { liveStreamingDetails: details }),
  };
}

function stream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    streamerId: `UC_${id}`,
    title: `VRChat ${id}`,
    thumbnail: `https://example.com/${id}.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    status: "live",
    ...overrides,
  };
}

async function prepareRoot(options: {
  tracked?: Stream[];
  streams?: Stream[];
  streamers?: Streamer[];
  discovery?: unknown;
  legacy?: boolean;
  blocklist?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-update-"));
  const generated = resolve(root, "data/generated");
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(root, "data/blocklist.yaml"), options.blocklist ?? "[]\n");
  if (options.tracked !== undefined || options.streams !== undefined) {
    const streams = options.streams ?? options.tracked ?? [];
    const payload = options.legacy
      ? { updatedAt: NOW.toISOString(), streams }
      : { updatedAt: NOW.toISOString(), tracked: options.tracked ?? streams, streams };
    await writeFile(resolve(generated, "streams.json"), JSON.stringify(payload));
  }
  if (options.streamers !== undefined) {
    await writeFile(resolve(generated, "streamers.json"), JSON.stringify({ updatedAt: NOW.toISOString(), streamers: options.streamers }));
  }
  if (options.discovery !== undefined) {
    await writeFile(resolve(generated, "discovery.json"), JSON.stringify(options.discovery));
  }
  return root;
}

async function generated(root: string): Promise<{ tracked: Stream[]; streams: Stream[] }> {
  return JSON.parse(await readFile(resolve(root, "data/generated/streams.json"), "utf8")) as { tracked: Stream[]; streams: Stream[] };
}

test("VRChat 判定は title/description を小文字化して包含判定する", () => {
  assert.equal(isVrchatContent("VRChat の夜", ""), true);
  assert.equal(isVrchatContent("雑談", "今日は vrCHAT で遊ぶ"), true);
  assert.equal(isVrchatContent("VRC", "virtual reality"), false);
});

test("日本語判定は title/description のかな文字だけを対象にする", () => {
  assert.equal(isJapaneseContent("ひらがな配信", ""), true);
  assert.equal(isJapaneseContent("カタカナ配信", ""), true);
  assert.equal(isJapaneseContent("VRChat stream", "説明にかなを含む"), true);
  assert.equal(isJapaneseContent("漢字配信", "中国語直播"), false);
  assert.equal(isJapaneseContent("VRChat stream", "English only"), false);
  assert.equal(isJapaneseContent("・ー、ｰ", "！？"), false);
  assert.equal(isJapaneseContent("ﾌﾞｲﾁｬｯﾄ", ""), true);
  assert.equal(isJapaneseContent("ｶｰ", ""), true);
});

test("Stream 型ガードは isJapanese の欠落を許容し非 boolean を拒否する", () => {
  assert.equal(isStream(stream("legacy")), true);
  assert.equal(isStream(stream("ja", { isJapanese: true })), true);
  assert.equal(isStream({ ...stream("invalid"), isJapanese: "true" }), false);
});

test("search.list は指定3クエリを part=id で実行する", async () => {
  const calls: URL[] = [];
  const result = await discoverVideoIds("secret", mockFetch((url) => {
    calls.push(url);
    return json({ items: [{ id: { videoId: `${url.searchParams.get("eventType")}-id` } }] });
  }));
  assert.equal(result.allSucceeded, true);
  assert.deepEqual([...result.videoIds].sort(), ["completed-id", "live-id", "upcoming-id"]);
  assert.deepEqual(calls.map((url) => url.searchParams.get("eventType")), ["live", "upcoming", "completed"]);
  for (const url of calls) {
    assert.equal(url.searchParams.get("part"), "id");
    assert.equal(url.searchParams.get("q"), "VRChat");
    assert.equal(url.searchParams.get("type"), "video");
    assert.equal(url.searchParams.get("maxResults"), "50");
    assert.equal(url.searchParams.get("relevanceLanguage"), "ja");
    assert.equal(url.searchParams.get("order"), "date");
  }
});

test("search.list の不正 item は warn してスキップし、有効 ID とクエリ成功を維持する", async () => {
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const mixed = await discoverVideoIds("secret", mockFetch((url) => json({
      items: [
        { id: {} },
        { id: { videoId: `${url.searchParams.get("eventType")}-valid` } },
        { kind: "youtube#searchResult" },
      ],
    })));
    assert.equal(mixed.allSucceeded, true);
    assert.equal(mixed.successfulQueries, 3);
    assert.equal(mixed.failedQueries.length, 0);
    assert.deepEqual([...mixed.videoIds].sort(), [
      "completed-valid",
      "live-valid",
      "upcoming-valid",
    ]);
    assert.equal(warnings.length, 6);
    assert.equal(warnings.every((warning) => warning.includes("スキップします")), true);
  } finally {
    console.warn = noopConsole;
  }

  const missingItems = await discoverVideoIds("secret", mockFetch(() => json({})));
  assert.equal(missingItems.successfulQueries, 0);
  assert.equal(missingItems.failedQueries.length, 3);
});

test("search 部分失敗は成功分を返し、全失敗も型で区別する", async () => {
  const partial = await discoverVideoIds("secret", mockFetch((url) =>
    url.searchParams.get("eventType") === "upcoming"
      ? json({ error: "failed" }, 500)
      : json({ items: [{ id: { videoId: url.searchParams.get("eventType") } }] }),
  ));
  assert.equal(partial.allSucceeded, false);
  assert.deepEqual([...partial.videoIds], ["live", "completed"]);
  const failed = await discoverVideoIds("secret", mockFetch(() => json({}, 503)));
  assert.equal(failed.successfulQueries, 0);
  assert.equal(failed.videoIds.size, 0);
});

test("refresh は状態・視聴者・チャンネルを動画ごとに返し不採用を成功と区別する", async () => {
  const result = await refreshStreams(["live", "ended", "ordinary", "wrong"], "secret", mockFetch(() => json({ items: [
    video("live", { details: { actualStartTime: NOW.toISOString(), concurrentViewers: "42" } }),
    video("ended", { details: { actualStartTime: "2026-07-30T10:00:00Z", actualEndTime: "2026-07-30T11:00:00Z" } }),
    video("ordinary", { details: null }),
    video("wrong", { title: "別ゲーム", description: "説明" }),
  ] })));
  const live = result.get("live");
  const ended = result.get("ended");
  assert.equal(live?.ok, true);
  assert.equal(live?.ok === true ? live.stream?.viewers : undefined, 42);
  assert.equal(live?.ok === true ? live.stream?.isJapanese : undefined, false);
  assert.equal(ended?.ok === true ? ended.stream?.status : undefined, "ended");
  assert.deepEqual(result.get("ordinary"), { ok: true });
  assert.deepEqual(result.get("wrong"), { ok: true });
});

test("refresh は変換時に title と description から日本語判定を付与する", async () => {
  const result = await refreshStreams(["english", "description-ja"], "secret", mockFetch(() => json({ items: [
    video("english", { title: "VRChat World Tour", description: "English stream" }),
    video("description-ja", { title: "VRChat World Tour", description: "一緒に遊びます" }),
  ] })));
  const english = result.get("english");
  const descriptionJa = result.get("description-ja");
  assert.equal(english?.ok === true ? english.stream?.isJapanese : undefined, false);
  assert.equal(descriptionJa?.ok === true ? descriptionJa.stream?.isJapanese : undefined, true);
});

test("表示窓は境界を含み、遠い upcoming は tracked 相当には残せる", () => {
  const values = [
    stream("ended-before", { status: "ended", actualEnd: "2026-07-29T11:59:59.999Z" }),
    stream("ended-at", { status: "ended", actualEnd: "2026-07-29T12:00:00.000Z" }),
    stream("past-at", { status: "upcoming", scheduledStart: "2026-07-23T12:00:00.000Z" }),
    stream("future-at", { status: "upcoming", scheduledStart: "2026-08-29T12:00:00.000Z" }),
    stream("future-outside", { status: "upcoming", scheduledStart: "2026-09-01T12:00:00.000Z" }),
  ];
  assert.deepEqual(filterStreams(values, NOW).map((item) => item.id), ["ended-at", "past-at", "future-at"]);
  assert.equal(values.some((item) => item.id === "future-outside"), true);
  assert.equal(filterStreams(values, new Date("2026-08-03T12:00:00Z")).some((item) => item.id === "future-outside"), true);
});

test("クールダウンは60分境界で切れ、欠落・不正・未来日時を期限切れ扱いする", () => {
  assert.equal(shouldDiscover({}, NOW), true);
  assert.equal(shouldDiscover({ discoveryAttemptedAt: "invalid" }, NOW), true);
  assert.equal(shouldDiscover({ discoveryAttemptedAt: "2026-07-30T12:00:00.001Z" }, NOW), true);
  assert.equal(shouldDiscover({ discoveryAttemptedAt: "2026-07-30T11:00:00.001Z" }, NOW), false);
  assert.equal(shouldDiscover({ discoveryAttemptedAt: "2026-07-30T11:00:00.000Z" }, NOW), true);
  assert.equal(shouldDiscover({ discoveryAttemptedAt: NOW.toISOString() }, NOW, true), true);
});

test("discoveredAt は3クエリ全成功時のみ更新する", async () => {
  const root = await prepareRoot({
    tracked: [stream("known")],
    streamers: [{ id: "UC_known", name: "旧", youtubeChannelId: "UC_known", enabled: true }],
    discovery: { discoveryAttemptedAt: "2026-07-30T10:00:00Z", discoveredAt: "2026-07-30T09:00:00Z" },
  });
  await runUpdate({ rootDir: root, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) => {
    if (url.pathname.endsWith("search")) {
      return url.searchParams.get("eventType") === "completed" ? json({}, 500) : json({ items: [] });
    }
    return json({ items: [video("known", { channelId: "UC_known", details: { actualStartTime: NOW.toISOString() } })] });
  }) });
  const state = JSON.parse(await readFile(resolve(root, "data/generated/discovery.json"), "utf8")) as Record<string, string>;
  assert.equal(state.discoveryAttemptedAt, NOW.toISOString());
  assert.equal(state.discoveredAt, "2026-07-30T09:00:00Z");
});

test("MAX_TRACKED は ended 古い順、次に upcoming 遠い順で削り live を削らない", () => {
  const values = [
    stream("live-a"), stream("live-b"),
    stream("ended-old", { status: "ended", actualEnd: "2026-07-30T08:00:00Z" }),
    stream("ended-new", { status: "ended", actualEnd: "2026-07-30T10:00:00Z" }),
    stream("near", { status: "upcoming", scheduledStart: "2026-07-31T00:00:00Z" }),
    stream("far", { status: "upcoming", scheduledStart: "2026-08-10T00:00:00Z" }),
  ];
  assert.deepEqual(limitTracked(values, 2).map((item) => item.id), ["live-a", "live-b", "near", "far"]);
  assert.deepEqual(limitTracked(values, 1).map((item) => item.id), ["live-a", "live-b", "near"]);
});

test("旧 streams を初期 tracked とし、除去規則①〜⑥を適用する", async () => {
  const previous = [
    stream("missing"),
    stream("old-ended", { status: "ended", actualEnd: "2026-07-28T00:00:00Z" }),
    stream("stale", { status: "upcoming", scheduledStart: "2026-07-20T00:00:00Z" }),
    stream("ordinary"), stream("wrong"),
    stream("blocked", { streamerId: "UC_BLOCK" }),
    stream("future", { streamerId: "UC_FUTURE", status: "upcoming", scheduledStart: "2026-09-01T00:00:00Z" }),
  ];
  const previousStreamers = previous.map((item) => ({ id: item.streamerId, name: item.id, youtubeChannelId: item.streamerId, enabled: true }));
  const root = await prepareRoot({ streams: previous, legacy: true, streamers: previousStreamers, blocklist: "- channelId: UC_BLOCK\n  note: test\n" });
  await runUpdate({ rootDir: root, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) => {
    if (url.pathname.endsWith("search")) return json({ items: [] });
    const ids = (url.searchParams.get("id") ?? "").split(",").filter((id) => id !== "missing");
    return json({ items: ids.map((id) => {
      if (id === "ordinary") return video(id, { details: null });
      if (id === "wrong") return video(id, { title: "別ゲーム", description: "なし" });
      const source = previous.find((item) => item.id === id);
      if (source?.status === "ended") return video(id, { details: { actualEndTime: source.actualEnd } });
      if (source?.status === "upcoming") return video(id, { channelId: source.streamerId, details: { scheduledStartTime: source.scheduledStart } });
      return video(id, {
        ...(source === undefined ? {} : { channelId: source.streamerId }),
        details: { actualStartTime: NOW.toISOString() },
      });
    }) });
  }) });
  const output = await generated(root);
  assert.deepEqual(output.tracked.map((item) => item.id), ["future"]);
  assert.deepEqual(output.streams, []);
});

test("refresh 部分バッチ失敗は前回動画を引き継ぎ、全滅時は本体不変で試行時刻だけ残す", async () => {
  const tracked = Array.from({ length: 51 }, (_, index) => stream(`id-${index}`));
  const streamers = tracked.map((item) => ({ id: item.streamerId, name: item.id, youtubeChannelId: item.streamerId, enabled: true }));
  const partialRoot = await prepareRoot({ tracked, streamers });
  await runUpdate({ rootDir: partialRoot, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) => {
    if (url.pathname.endsWith("search")) return json({ items: [] });
    const ids = (url.searchParams.get("id") ?? "").split(",");
    return ids.length === 50 ? json({}, 500) : json({ items: [video(ids[0] ?? "", { details: { actualStartTime: NOW.toISOString() } })] });
  }) });
  assert.equal((await generated(partialRoot)).tracked.length, 51);

  const failedRoot = await prepareRoot({ tracked: [stream("keep")], streamers: [{ id: "UC_keep", name: "keep", youtubeChannelId: "UC_keep", enabled: true }] });
  const streamsPath = resolve(failedRoot, "data/generated/streams.json");
  const streamersPath = resolve(failedRoot, "data/generated/streamers.json");
  const oldStreams = await readFile(streamsPath, "utf8");
  const oldStreamers = await readFile(streamersPath, "utf8");
  await assert.rejects(runUpdate({ rootDir: failedRoot, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) =>
    url.pathname.endsWith("search") ? json({ items: [] }) : json({}, 503),
  ) }), /全 refresh/);
  assert.equal(await readFile(streamsPath, "utf8"), oldStreams);
  assert.equal(await readFile(streamersPath, "utf8"), oldStreamers);
  const state = JSON.parse(await readFile(resolve(failedRoot, "data/generated/discovery.json"), "utf8")) as Record<string, string>;
  assert.equal(state.discoveryAttemptedAt, NOW.toISOString());
});

test("追跡0の空書込3分岐を守る", async () => {
  const emptySuccess = await prepareRoot();
  await runUpdate({ rootDir: emptySuccess, now: NOW, apiKey: "secret", fetchFn: mockFetch(() => json({ items: [] })) });
  assert.deepEqual((await generated(emptySuccess)).tracked, []);

  const failed = await prepareRoot();
  await assert.rejects(runUpdate({ rootDir: failed, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) =>
    url.searchParams.get("eventType") === "live" ? json({}, 500) : json({ items: [] }),
  ) }), /完全成功しなかった/);
  await assert.rejects(readFile(resolve(failed, "data/generated/streams.json"), "utf8"), /ENOENT/);
  const failedState = JSON.parse(await readFile(resolve(failed, "data/generated/discovery.json"), "utf8")) as Record<string, string>;
  assert.equal(failedState.discoveryAttemptedAt, NOW.toISOString());

  const cooldown = await prepareRoot({ discovery: { discoveryAttemptedAt: NOW.toISOString() } });
  let calls = 0;
  await runUpdate({ rootDir: cooldown, now: NOW, apiKey: "secret", fetchFn: mockFetch(() => { calls += 1; return json({ items: [] }); }) });
  assert.equal(calls, 0);
  await assert.rejects(readFile(resolve(cooldown, "data/generated/streams.json"), "utf8"), /ENOENT/);
});

test("discovery 全失敗でも既存 tracked の refresh を続行する", async () => {
  const root = await prepareRoot({ tracked: [stream("known")], streamers: [{ id: "UC_known", name: "old", youtubeChannelId: "UC_known", enabled: true }] });
  await runUpdate({ rootDir: root, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) =>
    url.pathname.endsWith("search")
      ? json({}, 500)
      : json({ items: [video("known", { details: { actualStartTime: NOW.toISOString() } })] }),
  ) });
  assert.deepEqual((await generated(root)).tracked.map((item) => item.id), ["known"]);
});

test("streamers は動画から生成し、部分失敗・旧独自ID・rename 中断に備えて2世代継承する", async () => {
  const legacy = stream("legacy", { streamerId: "zasan" });
  const oldStreamer = { id: "zasan", name: "ざぁさん", youtubeChannelId: "UC_REAL", enabled: true };
  const root = await prepareRoot({ streams: [legacy], legacy: true, streamers: [oldStreamer] });
  await runUpdate({ rootDir: root, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) =>
    url.pathname.endsWith("search") ? json({ items: [] }) : json({}, 500),
  ) }).catch(() => undefined);
  const unchanged = JSON.parse(await readFile(resolve(root, "data/generated/streamers.json"), "utf8")) as { streamers: Streamer[] };
  assert.equal(unchanged.streamers.some((item) => item.id === "zasan"), true);

  const nextRoot = await prepareRoot({
    tracked: [stream("old", { streamerId: "old-id" })],
    streams: [stream("old", { streamerId: "old-id" })],
    streamers: [{ id: "old-id", name: "old", youtubeChannelId: "old-id", enabled: true }],
  });
  await runUpdate({ rootDir: nextRoot, now: NOW, apiKey: "secret", fetchFn: mockFetch((url) => {
    if (url.pathname.endsWith("search")) return json({ items: [{ id: { videoId: "new" } }] });
    return json({ items: [video("old", { channelId: "old-id", details: { actualStartTime: NOW.toISOString() } }), video("new", { channelId: "UC_NEW", details: { actualStartTime: NOW.toISOString() } })] });
  }) });
  const streamerOutput = JSON.parse(await readFile(resolve(nextRoot, "data/generated/streamers.json"), "utf8")) as { streamers: Streamer[] };
  const output = await generated(nextRoot);
  const ids = new Set(streamerOutput.streamers.map((item) => item.id));
  assert.equal(ids.has("old-id"), true);
  assert.equal(ids.has("UC_NEW"), true);
  assert.equal(output.tracked.every((item) => ids.has(item.streamerId)), true);
});

test("blocklist は除外し空文字・重複・型不正を拒否、未知フィールドを無視する", () => {
  assert.deepEqual(validateBlocklist([{ channelId: "UC_OK", note: "x", unknown: true }]), [{ channelId: "UC_OK", note: "x" }]);
  assert.throws(() => validateBlocklist([{ channelId: "" }]), /非空文字列/);
  assert.throws(() => validateBlocklist([{ channelId: "UC_A" }, { channelId: "UC_A" }]), /重複/);
  assert.throws(() => validateBlocklist([{ channelId: 1 }]), /非空文字列/);
  assert.throws(() => validateBlocklist([{ channelId: "UC_A", note: 1 }]), /note/);
});

test("不正 blocklist は非0相当となり generated を維持する", async () => {
  const root = await prepareRoot({ tracked: [stream("keep")], blocklist: "- channelId: ''\n" });
  const path = resolve(root, "data/generated/streams.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(runUpdate({ rootDir: root, now: NOW, apiKey: "secret", fetchFn: mockFetch(() => json({ items: [] })) }), /blocklist/);
  assert.equal(await readFile(path, "utf8"), before);
});

test(".env は既存環境変数を優先し、引用符を処理する", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-env-"));
  const path = resolve(root, ".env");
  const existing = "VRSP_TEST_EXISTING";
  const loaded = "VRSP_TEST_LOADED";
  process.env[existing] = "keep";
  delete process.env[loaded];
  try {
    await writeFile(path, `${existing}=replace\n${loaded}='loaded value'\n`);
    await loadEnvFile(path);
    assert.equal(process.env[existing], "keep");
    assert.equal(process.env[loaded], "loaded value");
  } finally {
    delete process.env[existing];
    delete process.env[loaded];
  }
});
