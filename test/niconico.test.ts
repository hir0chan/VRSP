import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Stream, Streamer } from "../scripts/models.js";
import {
  convertPrograms,
  extractEmbeddedData,
  fetchVrchatNiconicoStreams,
  parseProgram,
  type NiconicoProgram,
} from "../scripts/niconico.js";
import { NSFW_TITLE_PATTERNS } from "../scripts/twitch.js";
import { runUpdate } from "../scripts/update.js";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const fixtureDir = resolve(import.meta.dirname, "fixtures");
const noopConsole = (): void => undefined;
console.warn = noopConsole;
console.error = noopConsole;
console.log = noopConsole;

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return handler(url, init);
  }) as typeof fetch;
}

function embedded(value: unknown): string {
  const encoded = JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<script id="embedded-data" data-props="${encoded}"></script>`;
}

function page(status: "onair" | "reserved", programs: unknown[], totalCount = programs.length): string {
  return embedded({ searchResult: { statusData: { [status]: { programs, totalCount } } } });
}

function program(id: string, overrides: Partial<NiconicoProgram> = {}): NiconicoProgram {
  return {
    title: `VRChat ${id}`,
    description: "架空の説明",
    listingThumbnail: `https://example.invalid/${id}.jpg`,
    watchPageUrl: `https://live.nicovideo.jp/watch/${id}`,
    nicoliveProgramId: id,
    beginTime: Math.floor(NOW.getTime() / 1_000),
    status: "ON_AIR",
    payment: false,
    isFollowerOnly: false,
    supplier: {
      name: `架空配信者 ${id}`,
      programProviderId: `user-${id}`,
    },
    ...overrides,
  };
}

async function fixtures(): Promise<{ onair: string; reserved: string }> {
  const [onair, reserved] = await Promise.all([
    readFile(resolve(fixtureDir, "nicolive_search_onair.html"), "utf8"),
    readFile(resolve(fixtureDir, "nicolive_search_reserved.html"), "utf8"),
  ]);
  return { onair, reserved };
}

function niconicoFetch(onair: string, reserved: string): typeof fetch {
  return mockFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("Accept"), "text/html");
    assert.match(new Headers(init?.headers).get("User-Agent") ?? "", /Mozilla/);
    return html(url.searchParams.get("status") === "onair" ? onair : reserved);
  });
}

test("実測 fixture はエンティティ構造を保った架空データで、live 2件・upcoming 1件に変換できる", async () => {
  const values = await fixtures();
  for (const source of Object.values(values)) {
    assert.match(source, /data-props="\{&quot;/);
    assert.doesNotMatch(source, /ハルルラ|隙間はやて|奏月 ここ|lv3511/);
  }
  assert.equal(typeof extractEmbeddedData(values.onair), "object");
  const result = await fetchVrchatNiconicoStreams(new Set(), niconicoFetch(values.onair, values.reserved), NOW);
  assert.deepEqual(result.streams.map((stream) => stream.id), ["nico-lv900000001", "nico-lv900000002", "nico-lv900000003"]);
  assert.deepEqual(result.streams.map((stream) => stream.status), ["live", "live", "upcoming"]);
  assert.equal(result.streams.every((stream) => stream.platform === "niconico" && stream.isJapanese === true && stream.viewers === undefined), true);
  assert.deepEqual(result.streamers.map((streamer) => streamer.id), ["nico-900001", "nico-900002", "nico-900003"]);
});

test("embedded-data の欠落・複数・不正 JSON・data-props 欠落を結果0件と区別して拒否する", () => {
  assert.throws(() => extractEmbeddedData("<html></html>"), /1件/);
  assert.throws(() => extractEmbeddedData(`${embedded({})}${embedded({})}`), /2件/);
  assert.throws(() => extractEmbeddedData('<script id="embedded-data" data-props="{&quot;x&quot;:"></script>'), /JSON\.parse/);
  assert.throws(() => extractEmbeddedData('<script id="embedded-data"></script>'), /data-props/);
  assert.throws(() => extractEmbeddedData('<script id="embedded-data" data-props="{&quot;x&quot;:&quot;&copy;&quot;}"></script>'), /未対応/);
});

test("program は unknown から必須型・beginTime の整数と範囲を検証し、個別不正だけを除外する", () => {
  const raw = {
    title: "VRChat",
    description: "説明",
    listingThumbnail: "https://example.invalid/thumb.jpg",
    watchPageUrl: "https://live.nicovideo.jp/watch/lv1",
    nicoliveProgramId: "lv1",
    beginTime: 1_785_938_065,
    status: "ON_AIR",
    payment: false,
    isFollowerOnly: false,
    supplier: { name: "架空", programProviderId: "1" },
  };
  assert.equal(parseProgram(raw, 0)?.nicoliveProgramId, "lv1");
  assert.equal(parseProgram({ ...raw, title: 1 }, 1), undefined);
  assert.equal(parseProgram({ ...raw, beginTime: 1.5 }, 2), undefined);
  assert.equal(parseProgram({ ...raw, beginTime: Number.MAX_SAFE_INTEGER }, 3), undefined);
});

test("変換は限定・有料・成人向け・blocklist・不明 status・31日先を除外し、重複は live を優先する", () => {
  const duplicateReserved = program("duplicate", { status: "RELEASED", beginTime: Math.floor((NOW.getTime() + 60_000) / 1_000) });
  const duplicateLive = program("duplicate", { title: "live wins" });
  const onair = [
    duplicateLive,
    program("paid", { payment: true }),
    program("followers", { isFollowerOnly: true }),
    program("blocked", { supplier: { ...program("x").supplier, programProviderId: "blocked" } }),
    program("unknown", { status: "ENDED" }),
    ...NSFW_TITLE_PATTERNS.map((pattern, index) => program(`nsfw-${index}`, { title: `title ${pattern}` })),
  ];
  const reserved = [
    duplicateReserved,
    program("near", { status: "RELEASED", beginTime: Math.floor((NOW.getTime() + 30 * 24 * 60 * 60 * 1_000) / 1_000) }),
    program("far", { status: "RELEASED", beginTime: Math.floor((NOW.getTime() + 31 * 24 * 60 * 60 * 1_000) / 1_000) }),
  ];
  const result = convertPrograms(onair, reserved, NOW, new Set(["nico-blocked"]));
  assert.deepEqual(result.streams.map((stream) => stream.id), ["nico-duplicate", "nico-near"]);
  assert.equal(result.streams[0]?.status, "live");
  assert.equal(result.streamers.length, 2);
});

test("HTTP・Content-Type・片側失敗・ルート構造不正をページ全体の失敗にする", async () => {
  const validProgram = {
    title: "VRChat", description: "説明", listingThumbnail: "https://example.invalid/a.jpg",
    watchPageUrl: "https://live.nicovideo.jp/watch/lv1", nicoliveProgramId: "lv1",
    beginTime: 1_785_938_065, status: "ON_AIR", payment: false, isFollowerOnly: false,
    supplier: { name: "架空", programProviderId: "1" },
  };
  const valid = page("onair", [validProgram]);
  await assert.rejects(fetchVrchatNiconicoStreams(new Set(), mockFetch((url) =>
    url.searchParams.get("status") === "reserved" ? html("failed", 503) : html(valid),
  ), NOW), /HTTP 503/);
  await assert.rejects(fetchVrchatNiconicoStreams(new Set(), mockFetch(() => json({})), NOW), /Content-Type/);
  await assert.rejects(fetchVrchatNiconicoStreams(new Set(), mockFetch((url) => html(page(url.searchParams.get("status") === "onair" ? "onair" : "reserved", []), 429)), NOW), /HTTP 429/);
  await assert.rejects(fetchVrchatNiconicoStreams(new Set(), mockFetch(() => html(embedded({ wrong: true }))), NOW), /ルート構造/);
  await assert.rejects(fetchVrchatNiconicoStreams(new Set(), mockFetch(() => {
    throw new DOMException("timed out", "TimeoutError");
  }), NOW), /検索\(onair\)に失敗/);
});

test("totalCount が取得件数を超える場合は黙って切り捨てず警告する", async () => {
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    await fetchVrchatNiconicoStreams(new Set(), mockFetch((url) => {
      const status = url.searchParams.get("status") === "onair" ? "onair" : "reserved";
      return html(page(status, [], status === "onair" ? 1 : 0));
    }), NOW);
    assert.equal(warnings.some((warning) => warning.includes("0/1件")), true);
  } finally {
    console.warn = noopConsole;
  }
});

function youtubeStream(id: string): Stream {
  return {
    id,
    streamerId: `UC_${id}`,
    title: id,
    thumbnail: `https://example.invalid/${id}.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    status: "live",
  };
}

function youtubeVideo(id: string): unknown {
  return {
    id,
    snippet: {
      channelId: `UC_${id}`,
      channelTitle: `YouTube ${id}`,
      title: `VRChat ${id}`,
      description: "",
      thumbnails: { high: { url: `https://example.invalid/${id}.jpg` } },
    },
    liveStreamingDetails: { actualStartTime: NOW.toISOString() },
  };
}

async function prepareRoot(options: { tracked?: Stream[]; cooldown?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-niconico-"));
  const generated = resolve(root, "data/generated");
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(root, "data/blocklist.yaml"), "[]\n");
  if (options.tracked !== undefined) {
    const streamers: Streamer[] = options.tracked.map((stream) => ({ id: stream.streamerId, name: stream.id, youtubeChannelId: stream.streamerId, enabled: true }));
    await writeFile(resolve(generated, "streams.json"), JSON.stringify({ updatedAt: NOW.toISOString(), tracked: options.tracked, streams: options.tracked }));
    await writeFile(resolve(generated, "streamers.json"), JSON.stringify({ updatedAt: NOW.toISOString(), streamers }));
  }
  if (options.cooldown) {
    await writeFile(resolve(generated, "discovery.json"), JSON.stringify({ discoveryAttemptedAt: NOW.toISOString() }));
  }
  return root;
}

async function updateFetch(failRefresh = false): Promise<typeof fetch> {
  const values = await fixtures();
  return mockFetch((url) => {
    if (url.hostname === "live.nicovideo.jp") return html(url.searchParams.get("status") === "onair" ? values.onair : values.reserved);
    if (url.pathname.endsWith("/search")) return json({ items: [] });
    if (url.pathname.endsWith("/videos")) return failRefresh ? json({}, 503) : json({ items: [youtubeVideo("known")] });
    throw new Error(`unexpected URL: ${url.toString()}`);
  });
}

async function generated(root: string): Promise<{ tracked: Stream[]; streams: Stream[] }> {
  return JSON.parse(await readFile(resolve(root, "data/generated/streams.json"), "utf8")) as { tracked: Stream[]; streams: Stream[] };
}

test("update の通常・追跡0 discovery・追跡0 cooldown の3書込経路すべてに niconico を合流する", async () => {
  const normal = await prepareRoot({ tracked: [youtubeStream("known")], cooldown: true });
  await runUpdate({ rootDir: normal, now: NOW, apiKey: "youtube-key", twitchClientId: "", twitchClientSecret: "", fetchFn: await updateFetch() });
  assert.equal((await generated(normal)).streams.filter((stream) => stream.platform === "niconico").length, 3);

  const discovery = await prepareRoot();
  await runUpdate({ rootDir: discovery, now: NOW, apiKey: "youtube-key", twitchClientId: "", twitchClientSecret: "", fetchFn: await updateFetch() });
  assert.equal((await generated(discovery)).streams.filter((stream) => stream.platform === "niconico").length, 3);

  const cooldown = await prepareRoot({ cooldown: true });
  await runUpdate({ rootDir: cooldown, now: NOW, apiKey: "youtube-key", twitchClientId: "", twitchClientSecret: "", fetchFn: await updateFetch() });
  assert.equal((await generated(cooldown)).streams.filter((stream) => stream.platform === "niconico").length, 3);
});

test("YouTube refresh 全滅時は niconico 成功でも本体を書き換えない", async () => {
  const root = await prepareRoot({ tracked: [youtubeStream("known")], cooldown: true });
  const path = resolve(root, "data/generated/streams.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(runUpdate({ rootDir: root, now: NOW, apiKey: "youtube-key", twitchClientId: "", twitchClientSecret: "", fetchFn: await updateFetch(true) }), /全 refresh/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("YOUTUBE_API_KEY 未設定時のモックは niconico live 2件・upcoming 1件を含む", async () => {
  const root = await prepareRoot();
  await runUpdate({ rootDir: root, now: NOW, apiKey: "" });
  const streams = (await generated(root)).streams.filter((stream) => stream.platform === "niconico");
  assert.deepEqual(streams.map((stream) => stream.status), ["live", "live", "upcoming"]);
});
