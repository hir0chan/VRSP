import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Stream, Streamer } from "../scripts/models.js";
import {
  loadEnvFile,
  mergeFetchResults,
  runUpdate,
  validateStreamers,
} from "../scripts/update.js";
import {
  fetchStreams,
  filterStreams,
  type FetchResult,
} from "../scripts/youtube.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function streamer(index: number): Streamer {
  return {
    id: `streamer-${index}`,
    name: `配信者${index}`,
    youtubeChannelId: `UC_${index}`,
    enabled: true,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return handler(url, init);
  }) as typeof fetch;
}

function endpoint(url: URL): string {
  return url.pathname.split("/").at(-1) ?? "";
}

function channelItems(ids: string[]): unknown[] {
  return ids.map((id) => ({
    id,
    snippet: { title: id },
    contentDetails: { relatedPlaylists: { uploads: `UU_${id}` } },
  }));
}

function liveVideo(
  id: string,
  details: Record<string, unknown>,
  thumbnails: Record<string, unknown> = {
    high: { url: `https://example.com/${id}.jpg` },
  },
): unknown {
  return {
    id,
    snippet: { title: `動画 ${id}`, thumbnails },
    liveStreamingDetails: details,
  };
}

function singleChannelFetch(
  videos: unknown[],
  playlistVideoIds = videos
    .filter(
      (value): value is { id: string } =>
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string",
    )
    .map((value) => value.id),
): typeof fetch {
  return mockFetch((url) => {
    if (endpoint(url) === "channels") {
      return json({ items: channelItems(["UC_0"]) });
    }
    if (endpoint(url) === "playlistItems") {
      return json({
        items: playlistVideoIds.map((videoId) => ({
          contentDetails: { videoId },
        })),
      });
    }
    return json({ items: videos });
  });
}

function baseStream(id: string, streamerId = "streamer-0"): Stream {
  return {
    id,
    streamerId,
    title: id,
    thumbnail: "https://example.com/thumbnail.jpg",
    url: `https://www.youtube.com/watch?v=${id}`,
    status: "live",
  };
}

test("YouTube 動画を upcoming/live/ended に変換しフィールドを割り当てる", async () => {
  const videos = [
    liveVideo("upcoming", {
      scheduledStartTime: "2026-07-31T12:00:00.000Z",
    }, {
      medium: { url: "https://example.com/medium.jpg" },
      default: { url: "https://example.com/default.jpg" },
    }),
    liveVideo("live", {
      scheduledStartTime: "2026-07-30T10:00:00.000Z",
      actualStartTime: "2026-07-30T10:05:00.000Z",
      concurrentViewers: "123",
    }),
    liveVideo("ended", {
      scheduledStartTime: "2026-07-30T07:00:00.000Z",
      actualStartTime: "2026-07-30T07:05:00.000Z",
      actualEndTime: "2026-07-30T08:00:00.000Z",
    }),
    {
      id: "ordinary",
      snippet: {
        title: "通常動画",
        thumbnails: { high: { url: "https://example.com/ordinary.jpg" } },
      },
    },
  ];

  const result = (await fetchStreams(
    [streamer(0)],
    "secret",
    singleChannelFetch(videos),
  )).get("streamer-0");
  assert.equal(result?.ok, true);
  if (result?.ok !== true) {
    return;
  }
  assert.deepEqual(
    result.streams.map((stream) => stream.status),
    ["upcoming", "live", "ended"],
  );
  assert.equal(result.streams[0]?.thumbnail, "https://example.com/medium.jpg");
  assert.equal(result.streams[1]?.viewers, 123);
  assert.equal(result.streams[2]?.actualEnd, "2026-07-30T08:00:00.000Z");
});

test("ended 24時間・upcoming 過去7日から未来30日の境界を含める", () => {
  const streams: Stream[] = [
    { ...baseStream("ended-before"), status: "ended", actualEnd: "2026-07-29T11:59:59.999Z" },
    { ...baseStream("ended-at"), status: "ended", actualEnd: "2026-07-29T12:00:00.000Z" },
    { ...baseStream("past-before"), status: "upcoming", scheduledStart: "2026-07-23T11:59:59.999Z" },
    { ...baseStream("past-at"), status: "upcoming", scheduledStart: "2026-07-23T12:00:00.000Z" },
    { ...baseStream("future-at"), status: "upcoming", scheduledStart: "2026-08-29T12:00:00.000Z" },
    { ...baseStream("future-after"), status: "upcoming", scheduledStart: "2026-08-29T12:00:00.001Z" },
    baseStream("live"),
  ];
  assert.deepEqual(
    filterStreams(streams, NOW).map((stream) => stream.id),
    ["ended-at", "past-at", "future-at", "live"],
  );
});

test("channels.list と videos.list を最大50件に分割する", async () => {
  const streamers = Array.from({ length: 51 }, (_, index) => streamer(index));
  const channelBatchSizes: number[] = [];
  const videoBatchSizes: number[] = [];
  const fetchFn = mockFetch((url) => {
    if (endpoint(url) === "channels") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      channelBatchSizes.push(ids.length);
      return json({ items: channelItems(ids) });
    }
    if (endpoint(url) === "playlistItems") {
      const playlistId = url.searchParams.get("playlistId") ?? "";
      return json({
        items: [{ contentDetails: { videoId: `video-${playlistId}` } }],
      });
    }
    const ids = (url.searchParams.get("id") ?? "").split(",");
    videoBatchSizes.push(ids.length);
    return json({ items: ids.map((id) => ({
      id,
      snippet: { title: id, thumbnails: {} },
    })) });
  });
  const results = await fetchStreams(streamers, "secret", fetchFn);
  assert.deepEqual(channelBatchSizes, [50, 1]);
  assert.deepEqual(videoBatchSizes, [50, 1]);
  assert.equal([...results.values()].every((result) => result.ok), true);
});

test("live の不正 viewers は省略し有限な非負値だけを残す", async () => {
  const videos = [
    liveVideo("negative", { actualStartTime: NOW.toISOString(), concurrentViewers: "-1" }),
    liveVideo("nan", { actualStartTime: NOW.toISOString(), concurrentViewers: "not-a-number" }),
    liveVideo("infinity", { actualStartTime: NOW.toISOString(), concurrentViewers: "Infinity" }),
    liveVideo("valid", { actualStartTime: NOW.toISOString(), concurrentViewers: "0" }),
  ];
  const result = (await fetchStreams(
    [streamer(0)],
    "secret",
    singleChannelFetch(videos),
  )).get("streamer-0");
  assert.equal(result?.ok, true);
  if (result?.ok !== true) {
    return;
  }
  assert.deepEqual(
    result.streams.map((stream) => stream.viewers),
    [undefined, undefined, undefined, 0],
  );
});

test("予定日時欠落・不正日時・サムネイル欠落の動画を除外する", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const result = (await fetchStreams(
      [streamer(0)],
      "secret",
      singleChannelFetch([
        liveVideo("missing-date", {}),
        liveVideo("invalid-date", { scheduledStartTime: "invalid" }),
        liveVideo("missing-thumbnail", {
          scheduledStartTime: "2026-07-31T00:00:00.000Z",
        }, {}),
      ]),
    )).get("streamer-0");
    assert.deepEqual(result, { ok: true, streams: [] });
    assert.equal(warnings.length, 3);
  } finally {
    console.warn = originalWarn;
  }
});

test("channels.list の item 欠落と uploads 欠落を配信者ごとの失敗にする", async () => {
  const fetchFn = mockFetch((url) => {
    if (endpoint(url) === "channels") {
      return json({
        items: [
          {
            id: "UC_1",
            snippet: { title: "配信者1" },
            contentDetails: { relatedPlaylists: {} },
          },
          ...channelItems(["UC_2"]),
        ],
      });
    }
    return json({ items: [] });
  });
  const results = await fetchStreams(
    [streamer(0), streamer(1), streamer(2)],
    "secret",
    fetchFn,
  );
  assert.equal(results.get("streamer-0")?.ok, false);
  assert.equal(results.get("streamer-1")?.ok, false);
  assert.deepEqual(results.get("streamer-2"), { ok: true, streams: [] });
});

test("channels.list バッチ失敗は当該50件だけ失敗させ後続を継続する", async () => {
  const streamers = Array.from({ length: 51 }, (_, index) => streamer(index));
  let channelsCall = 0;
  const fetchFn = mockFetch((url) => {
    if (endpoint(url) === "channels") {
      channelsCall += 1;
      if (channelsCall === 1) {
        return json({ error: { message: "quota" } }, 500);
      }
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return json({ items: channelItems(ids) });
    }
    return json({ items: [] });
  });
  const results = await fetchStreams(streamers, "secret", fetchFn);
  assert.equal(channelsCall, 2);
  assert.equal(
    streamers.slice(0, 50).every((value) => results.get(value.id)?.ok === false),
    true,
  );
  assert.deepEqual(results.get("streamer-50"), { ok: true, streams: [] });
});

test("playlistItems.list の HTTP エラーを当該配信者に帰属させる", async () => {
  const fetchFn = mockFetch((url) => {
    if (endpoint(url) === "channels") {
      return json({ items: channelItems(["UC_0", "UC_1"]) });
    }
    if (
      endpoint(url) === "playlistItems" &&
      url.searchParams.get("playlistId") === "UU_UC_0"
    ) {
      return json({ error: { message: "forbidden" } }, 403);
    }
    return json({ items: [] });
  });
  const results = await fetchStreams(
    [streamer(0), streamer(1)],
    "secret",
    fetchFn,
  );
  assert.equal(results.get("streamer-0")?.ok, false);
  assert.deepEqual(results.get("streamer-1"), { ok: true, streams: [] });
});

test("videos.list バッチ失敗はその動画を持つ配信者だけ失敗させる", async () => {
  let videoCall = 0;
  const fetchFn = mockFetch((url) => {
    if (endpoint(url) === "channels") {
      return json({ items: channelItems(["UC_0", "UC_1"]) });
    }
    if (endpoint(url) === "playlistItems") {
      const first = url.searchParams.get("playlistId") === "UU_UC_0";
      return json({
        items: Array.from({ length: first ? 50 : 1 }, (_, index) => ({
          contentDetails: {
            videoId: first ? `first-${index}` : "second-only",
          },
        })),
      });
    }
    videoCall += 1;
    if (videoCall === 1) {
      return json({ error: { message: "backend error" } }, 503);
    }
    return json({
      items: [
        liveVideo("second-only", {
          scheduledStartTime: "2026-07-31T00:00:00.000Z",
        }),
      ],
    });
  });
  const results = await fetchStreams(
    [streamer(0), streamer(1)],
    "secret",
    fetchFn,
  );
  assert.equal(results.get("streamer-0")?.ok, false);
  assert.equal(results.get("streamer-1")?.ok, true);
});

test("videos.list の個別動画欠落は動画だけを除外して成功を保つ", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const result = (await fetchStreams(
      [streamer(0)],
      "secret",
      singleChannelFetch(
        [
          liveVideo("present", {
            scheduledStartTime: "2026-07-31T00:00:00.000Z",
          }),
        ],
        ["present", "deleted"],
      ),
    )).get("streamer-0");
    assert.equal(result?.ok, true);
    if (result?.ok === true) {
      assert.deepEqual(result.streams.map((stream) => stream.id), ["present"]);
    }
    assert.match(warnings[0] ?? "", /deleted/);
  } finally {
    console.warn = originalWarn;
  }
});

test("AbortError とタイムアウト signal を失敗結果に変換する", async () => {
  let receivedSignal: AbortSignal | null | undefined;
  const fetchFn = mockFetch((_url, init) => {
    receivedSignal = init?.signal;
    throw new DOMException("timed out", "AbortError");
  });
  const result = (await fetchStreams(
    [streamer(0)],
    "secret",
    fetchFn,
  )).get("streamer-0");
  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(result?.ok, false);
  if (result?.ok === false) {
    assert.match(result.error.message, /AbortError|timed out/);
  }
});

test("不正JSON・必須 items 欠落・不正 video item をリクエスト単位の失敗にする", async (context) => {
  await context.test("channels.list の不正JSON", async () => {
    const result = (await fetchStreams(
      [streamer(0)],
      "secret",
      mockFetch(() => new Response("{invalid")),
    )).get("streamer-0");
    assert.equal(result?.ok, false);
  });

  await context.test("playlistItems.list の items 欠落", async () => {
    const result = (await fetchStreams(
      [streamer(0)],
      "secret",
      mockFetch((url) =>
        endpoint(url) === "channels"
          ? json({ items: channelItems(["UC_0"]) })
          : json({ pageInfo: {} }),
      ),
    )).get("streamer-0");
    assert.equal(result?.ok, false);
  });

  await context.test("videos.list の必須 snippet 欠落", async () => {
    const result = (await fetchStreams(
      [streamer(0)],
      "secret",
      singleChannelFetch([{ id: "broken" }]),
    )).get("streamer-0");
    assert.equal(result?.ok, false);
  });
});

test("対象動画0件の成功と API 失敗を Result 型で区別する", async () => {
  const success = await fetchStreams(
    [streamer(0)],
    "secret",
    singleChannelFetch([]),
  );
  const failure = await fetchStreams(
    [streamer(0)],
    "secret",
    mockFetch(() => json({ error: {} }, 500)),
  );
  assert.deepEqual(success.get("streamer-0"), { ok: true, streams: [] });
  assert.equal(failure.get("streamer-0")?.ok, false);
});

test("各 API の part・上限を指定しエラーにも API キーを出さない", async () => {
  const parameters = new Map<string, URLSearchParams>();
  const successFetch = mockFetch((url) => {
    parameters.set(endpoint(url), url.searchParams);
    if (endpoint(url) === "channels") {
      return json({ items: channelItems(["UC_0"]) });
    }
    if (endpoint(url) === "playlistItems") {
      return json({ items: [{ contentDetails: { videoId: "video" } }] });
    }
    return json({ items: [] });
  });
  await fetchStreams([streamer(0)], "super-secret", successFetch);
  assert.equal(parameters.get("channels")?.get("part"), "snippet,contentDetails");
  assert.equal(parameters.get("playlistItems")?.get("part"), "contentDetails");
  assert.equal(parameters.get("playlistItems")?.get("maxResults"), "10");
  assert.equal(
    parameters.get("videos")?.get("part"),
    "snippet,liveStreamingDetails",
  );

  const failed = (await fetchStreams(
    [streamer(0)],
    "super-secret",
    mockFetch(() =>
      json({ error: { message: "rejected super-secret" } }, 400),
    ),
  )).get("streamer-0");
  assert.equal(failed?.ok, false);
  if (failed?.ok === false) {
    assert.doesNotMatch(failed.error.message, /super-secret/);
    assert.match(failed.error.message, /\[REDACTED\]/);
  }
});

test("部分失敗では成功者を更新し失敗者だけ前回値を引き継ぐ", () => {
  const streamers = [streamer(0), streamer(1)];
  const current = baseStream("current", "streamer-0");
  const previousSuccess = baseStream("old-success", "streamer-0");
  const previousFailure = baseStream("old-failure", "streamer-1");
  const results = new Map<string, FetchResult>([
    ["streamer-0", { ok: true, streams: [current] }],
    ["streamer-1", { ok: false, error: new Error("failed") }],
  ]);
  const merged = mergeFetchResults(
    streamers,
    results,
    [previousSuccess, previousFailure],
  );
  assert.deepEqual(merged.streams, [current, previousFailure]);
  assert.deepEqual(merged.failedStreamerIds, ["streamer-1"]);
});

async function prepareUpdateRoot(yaml: string): Promise<{
  root: string;
  streamsPath: string;
  streamersPath: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-youtube-"));
  const generated = resolve(root, "data/generated");
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(root, "data/streamers.yaml"), yaml);
  return {
    root,
    streamsPath: resolve(generated, "streams.json"),
    streamersPath: resolve(generated, "streamers.json"),
  };
}

const TWO_STREAMERS_YAML =
  "- id: streamer-0\n  name: A\n  youtubeChannelId: UC_0\n  enabled: true\n" +
  "- id: streamer-1\n  name: B\n  youtubeChannelId: UC_1\n  enabled: true\n";

function partialFailureFetch(): typeof fetch {
  return mockFetch((url) => {
    if (endpoint(url) === "channels") {
      return json({ items: channelItems(["UC_0", "UC_1"]) });
    }
    if (endpoint(url) === "playlistItems") {
      if (url.searchParams.get("playlistId") === "UU_UC_1") {
        return json({ error: { message: "failure" } }, 500);
      }
      return json({
        items: [{ contentDetails: { videoId: "current" } }],
      });
    }
    return json({
      items: [
        liveVideo("current", {
          scheduledStartTime: "2026-07-30T11:00:00.000Z",
          actualStartTime: "2026-07-30T11:05:00.000Z",
        }),
      ],
    });
  });
}

test("前回 JSON が無い・破損している部分失敗でも成功者分で更新する", async (context) => {
  for (const previous of ["missing", "broken"] as const) {
    await context.test(previous, async () => {
      const prepared = await prepareUpdateRoot(TWO_STREAMERS_YAML);
      if (previous === "broken") {
        await writeFile(prepared.streamsPath, "{broken");
      }
      await runUpdate({
        rootDir: prepared.root,
        now: NOW,
        apiKey: "secret",
        fetchFn: partialFailureFetch(),
      });
      const generated = JSON.parse(
        await readFile(prepared.streamsPath, "utf8"),
      ) as { streams: Stream[] };
      assert.deepEqual(generated.streams.map((stream) => stream.id), ["current"]);
    });
  }
});

test("全配信者失敗時は両 generated を一切変更しない", async () => {
  const prepared = await prepareUpdateRoot(TWO_STREAMERS_YAML);
  const oldStreams = '{"marker":"old streams"}\n';
  const oldStreamers = '{"marker":"old streamers"}\n';
  await writeFile(prepared.streamsPath, oldStreams);
  await writeFile(prepared.streamersPath, oldStreamers);
  await assert.rejects(
    runUpdate({
      rootDir: prepared.root,
      now: NOW,
      apiKey: "secret",
      fetchFn: mockFetch(() => json({ error: {} }, 500)),
    }),
    /全配信者の取得に失敗/,
  );
  assert.equal(await readFile(prepared.streamsPath, "utf8"), oldStreams);
  assert.equal(await readFile(prepared.streamersPath, "utf8"), oldStreamers);
});

test("enabled 0件は CLI で非0終了し generated を変更しない", async () => {
  const prepared = await prepareUpdateRoot(
    "- id: disabled\n  name: Disabled\n  youtubeChannelId: UC_DISABLED\n  enabled: false\n",
  );
  await writeFile(prepared.streamsPath, "old streams");
  await writeFile(prepared.streamersPath, "old streamers");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
      resolve(process.cwd(), "scripts/update.ts"),
    ],
    { cwd: prepared.root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enabled な配信者がいません/);
  assert.equal(await readFile(prepared.streamsPath, "utf8"), "old streams");
  assert.equal(await readFile(prepared.streamersPath, "utf8"), "old streamers");
});

test("youtubeChannelId 重複を enabled 状態にかかわらず拒否する", () => {
  assert.throws(
    () =>
      validateStreamers([
        streamer(0),
        { ...streamer(1), youtubeChannelId: "UC_0", enabled: false },
      ]),
    /重複した youtubeChannelId/,
  );
});

test(".env は既存環境変数を優先し空白キー値を未設定のまま扱える", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-env-"));
  const path = resolve(root, ".env");
  const preservedKey = "VRSP_TEST_PRESERVED";
  const loadedKey = "VRSP_TEST_LOADED";
  const originalYoutubeApiKey = process.env.YOUTUBE_API_KEY;
  process.env[preservedKey] = "existing";
  delete process.env[loadedKey];
  delete process.env.YOUTUBE_API_KEY;
  try {
    await writeFile(
      path,
      `# comment\n${preservedKey}=replacement\n${loadedKey}= loaded \nYOUTUBE_API_KEY=   \n`,
    );
    await loadEnvFile(path);
    assert.equal(process.env[preservedKey], "existing");
    assert.equal(process.env[loadedKey], "loaded");
    const loadedYoutubeApiKey = Reflect.get(
      process.env,
      "YOUTUBE_API_KEY",
    ) as string | undefined;
    assert.equal(loadedYoutubeApiKey?.trim() ?? "", "");
  } finally {
    delete process.env[preservedKey];
    delete process.env[loadedKey];
    if (originalYoutubeApiKey === undefined) {
      delete process.env.YOUTUBE_API_KEY;
    } else {
      process.env.YOUTUBE_API_KEY = originalYoutubeApiKey;
    }
  }
});

test(".env は対になった引用符だけを値から取り除く", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-env-quotes-"));
  const path = resolve(root, ".env");
  const keys = {
    double: "VRSP_TEST_DOUBLE_QUOTED",
    single: "VRSP_TEST_SINGLE_QUOTED",
    unpaired: "VRSP_TEST_UNPAIRED_QUOTE",
  };
  for (const key of Object.values(keys)) {
    delete process.env[key];
  }
  try {
    await writeFile(
      path,
      `${keys.double}="double-value"\n${keys.single}='single-value'\n${keys.unpaired}="unpaired-value\n`,
    );
    await loadEnvFile(path);
    assert.equal(process.env[keys.double], "double-value");
    assert.equal(process.env[keys.single], "single-value");
    assert.equal(process.env[keys.unpaired], `"unpaired-value`);
  } finally {
    for (const key of Object.values(keys)) {
      delete process.env[key];
    }
  }
});
