import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  announcedKey,
  composeDigest,
  countLiveJapanese,
  postToIfttt,
  pruneAnnounced,
  runDigest,
  sanitizeName,
  selectNewLives,
  shouldPost,
  weightedLength,
} from "../scripts/digest.js";
import type { AnnouncedEntry, DigestState, Stream, Streamer } from "../scripts/models.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const SITE_URL = "https://vcha-antenna.com/";

function postWeightedLength(text: string): number {
  assert.equal(text.endsWith(SITE_URL), true);
  return weightedLength(text.slice(0, -SITE_URL.length)) + 23;
}

function stream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    streamerId: `streamer-${id}`,
    title: `VRChat ${id}`,
    thumbnail: `https://example.invalid/${id}.jpg`,
    url: `https://example.invalid/watch/${id}`,
    status: "live",
    actualStart: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    isJapanese: true,
    ...overrides,
  };
}

function streamer(id: string, name = `配信者 ${id}`): Streamer {
  return {
    id: `streamer-${id}`,
    name,
    youtubeChannelId: `streamer-${id}`,
    enabled: true,
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

async function prepareRoot(options: {
  streams?: unknown;
  streamers?: unknown;
  state?: unknown;
} = {}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-digest-"));
  const generated = resolve(root, "data/generated");
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(generated, "streams.json"), JSON.stringify({
    updatedAt: NOW.toISOString(),
    streams: options.streams ?? [],
  }));
  await writeFile(resolve(generated, "streamers.json"), JSON.stringify({
    updatedAt: NOW.toISOString(),
    streamers: options.streamers ?? [],
  }));
  if (options.state !== undefined) {
    await writeFile(resolve(generated, "digest.json"), typeof options.state === "string" ? options.state : JSON.stringify(options.state));
  }
  return root;
}

async function readState(root: string): Promise<DigestState> {
  return JSON.parse(await readFile(resolve(root, "data/generated/digest.json"), "utf8")) as DigestState;
}

test("複合キーで既知を除外し、JP live を開始時刻・キー順で決定的に選ぶ", () => {
  const missingStart = stream("same", { platform: "niconico" });
  delete missingStart.actualStart;
  const unknownLanguage = stream("unknown-language");
  delete unknownLanguage.isJapanese;
  const values = [
    stream("same", { platform: "twitch", actualStart: "invalid" }),
    stream("later", { actualStart: new Date(NOW.getTime() - HOUR_MS).toISOString() }),
    missingStart,
    stream("earlier", { actualStart: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() }),
    stream("known"),
    stream("non-ja", { isJapanese: false }),
    unknownLanguage,
    stream("ended", { status: "ended" }),
  ];
  assert.equal(announcedKey(stream("known")), "youtube:known");
  assert.equal(announcedKey(stream("same", { platform: "twitch" })), "twitch:same");
  assert.deepEqual(
    selectNewLives(values, [{ id: "youtube:known", at: NOW.toISOString() }]).map(announcedKey),
    ["youtube:earlier", "youtube:later", "niconico:same", "twitch:same"],
  );
  assert.equal(countLiveJapanese(values), 5);
});

test("名前の制御文字と投稿誘導記号を除去し、重み付き40以内で安全に切り詰める", () => {
  const value = sanitizeName("  A\n\u0000 @user ＠user #tag ＃tag t.co．jp。x｡y 😀e\u0301 とても長い配信者名です  ");
  assert.doesNotMatch(value, /[\p{Cc}@＠#＃.．。｡]/u);
  assert.doesNotMatch(value, /\s{2,}/u);
  assert.match(value, /・user/);
  assert.equal(weightedLength(value) <= 40, true);
  assert.equal(value.endsWith("…"), true);
  assert.equal(weightedLength("abcé"), 4);
  assert.equal(weightedLength("日本😀"), 6);
  assert.equal(weightedLength("https://example.invalid/a"), "https://example.invalid/a".length);
});

test("ドットなしの長いURL風配信者名も40で切り詰め、本文を280以内に収める", () => {
  const maliciousName = `https://${"a".repeat(200)}`;
  const sanitized = sanitizeName(maliciousName);
  assert.equal(weightedLength(sanitized), 40);
  assert.equal(sanitized.endsWith("…"), true);

  const text = composeDigest([stream("malicious")], 1, [streamer("malicious", maliciousName)]);
  assert.equal(postWeightedLength(text) <= 280, true);
  assert.doesNotMatch(text, new RegExp(`a{${200}}`));
});

test("本文は解決不能・空名を残件数に含め、多数名でも重み付き280以内に収める", () => {
  const lives = Array.from({ length: 20 }, (_, index) => stream(String(index)));
  const people = lives.slice(0, 18).map((value, index) => streamer(value.id, index === 0 ? "\n\u0000" : `とても長い配信者名${index}`));
  const text = composeDigest(lives, 25, people);
  assert.match(text, /^🔴 VRChat配信が新たにスタート!/);
  assert.match(text, /ほか\d+件/);
  assert.match(text, /現在25件がライブ配信中👀/);
  assert.match(text, /https:\/\/vcha-antenna\.com\/$/);
  assert.equal(postWeightedLength(text) <= 280, true);

  const fallback = composeDigest([stream("missing")], 1, []);
  assert.match(fallback, /1件の配信がスタート!/);
});

test("投稿間隔は120分ちょうどを許可し、未来24時間以内はスキップ、超過は拒否する", () => {
  const state = (offsetMs: number): DigestState => ({
    lastPostedAt: new Date(NOW.getTime() + offsetMs).toISOString(),
    announced: [],
  });
  assert.equal(shouldPost(state(-120 * 60 * 1_000 + 1_000), NOW), false);
  assert.equal(shouldPost(state(-120 * 60 * 1_000), NOW), true);
  assert.equal(shouldPost(state(HOUR_MS), NOW), false);
  assert.equal(shouldPost(state(24 * HOUR_MS), NOW), false);
  assert.throws(() => shouldPost(state(25 * HOUR_MS), NOW), /24時間を超えて未来/);
  assert.throws(() => shouldPost({ lastPostedAt: "invalid", announced: [] }, NOW), /不正な日時/);
});

test("announced は非liveかつ24時間超過だけを剪定する", () => {
  const entries: AnnouncedEntry[] = [
    { id: "youtube:live-old", at: new Date(NOW.getTime() - 100 * HOUR_MS).toISOString() },
    { id: "youtube:ended-old", at: new Date(NOW.getTime() - 24 * HOUR_MS - 1).toISOString() },
    { id: "youtube:ended-boundary", at: new Date(NOW.getTime() - 24 * HOUR_MS).toISOString() },
  ];
  assert.deepEqual(
    pruneAnnounced(entries, new Set(["youtube:live-old"]), NOW).map((entry) => entry.id),
    ["youtube:live-old", "youtube:ended-boundary"],
  );
});

test("IFTTT POST はJSON・redirect error・15秒タイムアウトを使い、失敗情報を秘匿する", async () => {
  let requestSignal: AbortSignal | null | undefined;
  const timeoutValues: number[] = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((milliseconds: number) => {
    timeoutValues.push(milliseconds);
    return originalTimeout(milliseconds);
  });
  try {
    await postToIfttt("本文", "secret/key", mockFetch((url, init) => {
      assert.equal(url.pathname, "/trigger/vrsp_digest/with/key/secret%2Fkey");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { value1: "本文" });
      requestSignal = init?.signal;
      return new Response("accepted", { status: 200 });
    }));
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.equal(requestSignal instanceof AbortSignal, true);
  assert.deepEqual(timeoutValues, [15_000]);

  const responseError = await postToIfttt("本文", "secret/key", mockFetch(() =>
    new Response("private response", { status: 503 }),
  )).then(() => undefined, (error: unknown) => error);
  assert.match(String(responseError), /HTTP 503/);
  assert.doesNotMatch(String(responseError), /secret|private|maker\.ifttt/);

  const fetchError = await postToIfttt("本文", "secret/key", mockFetch(() => {
    throw new Error("https://maker.ifttt.com/private response secret%2Fkey");
  })).then(() => undefined, (error: unknown) => error);
  assert.match(String(fetchError), /送信に失敗/);
  assert.doesNotMatch(String(fetchError), /secret|private|maker\.ifttt/);
});

test("初回は全platformの現在liveをベースライン記録し、投稿しない", async () => {
  const values = [
    stream("jp"),
    stream("non-ja", { platform: "twitch", isJapanese: false }),
    stream("upcoming", { platform: "niconico", status: "upcoming" }),
  ];
  const root = await prepareRoot({ streams: values, streamers: values.map((value) => streamer(value.id)) });
  let fetched = false;
  const result = await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "ifttt-key",
    youtubeApiKey: "youtube-key",
    fetchFn: mockFetch(() => {
      fetched = true;
      return new Response(null, { status: 200 });
    }),
  });
  assert.equal(result, "initialized");
  assert.equal(fetched, false);
  assert.deepEqual((await readState(root)).announced.map((entry) => entry.id), ["youtube:jp", "twitch:non-ja"]);
});

test("新規2件と既知1件から本文を投稿し、複合キー・lastPostedAtを原子的に更新する", async () => {
  const known = stream("known");
  const youtube = stream("same");
  const twitch = stream("same", { platform: "twitch" });
  const oldAt = new Date(NOW.getTime() - 3 * HOUR_MS).toISOString();
  const root = await prepareRoot({
    streams: [known, youtube, twitch],
    streamers: [streamer("known", "既知さん"), streamer("same", "新規さん")],
    state: { lastPostedAt: oldAt, announced: [{ id: "youtube:known", at: oldAt }] },
  });
  let postedText = "";
  const result = await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "ifttt-key",
    youtubeApiKey: "youtube-key",
    fetchFn: mockFetch((_url, init) => {
      postedText = (JSON.parse(String(init?.body)) as { value1: string }).value1;
      return new Response(null, { status: 204 });
    }),
  });
  assert.equal(result, "posted");
  assert.doesNotMatch(postedText, /既知さん/);
  assert.match(postedText, /新規さん \/ 新規さん/);
  const state = await readState(root);
  assert.equal(state.lastPostedAt, NOW.toISOString());
  assert.deepEqual(state.announced.map((entry) => entry.id), ["youtube:known", "twitch:same", "youtube:same"]);
});

test("新規0件・119分59秒では投稿せずstateを変更しない", async () => {
  for (const options of [
    { streams: [stream("known")], announced: [{ id: "youtube:known", at: NOW.toISOString() }], offset: -3 * HOUR_MS },
    { streams: [stream("new")], announced: [], offset: -120 * 60 * 1_000 + 1_000 },
  ]) {
    const state = { lastPostedAt: new Date(NOW.getTime() + options.offset).toISOString(), announced: options.announced };
    const root = await prepareRoot({ streams: options.streams, streamers: options.streams.map((value) => streamer(value.id)), state });
    const before = await readFile(resolve(root, "data/generated/digest.json"), "utf8");
    const result = await runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key", fetchFn: mockFetch(() => {
      throw new Error("投稿されるべきではありません");
    }) });
    assert.equal(result, "skipped");
    assert.equal(await readFile(resolve(root, "data/generated/digest.json"), "utf8"), before);
  }
});

test("各キーの片方だけが欠けても入力読込・投稿・state更新なしで正常スキップする", async () => {
  for (const keys of [
    { iftttWebhookKey: "", youtubeApiKey: "youtube" },
    { iftttWebhookKey: "ifttt", youtubeApiKey: "" },
  ]) {
    const root = await mkdtemp(resolve(tmpdir(), "vrsp-digest-no-input-"));
    const result = await runDigest({
      rootDir: root,
      now: NOW,
      iftttWebhookKey: keys.iftttWebhookKey,
      youtubeApiKey: keys.youtubeApiKey,
      fetchFn: mockFetch(() => {
        throw new Error("投稿されるべきではありません");
      }),
    });
    assert.equal(result, "skipped-keys");
    await assert.rejects(readFile(resolve(root, "data/generated/digest.json"), "utf8"), /ENOENT/);
  }
});

test("stateのJSON破損・型不正・重複キー・不正日時と入力破損を拒否しstateを保つ", async () => {
  const invalidStates: unknown[] = [
    "{",
    { announced: "invalid" },
    { announced: [{ id: "youtube:a", at: NOW.toISOString() }, { id: "youtube:a", at: NOW.toISOString() }] },
    { announced: [{ id: "youtube:a", at: "invalid" }] },
    { lastPostedAt: "invalid", announced: [] },
  ];
  for (const invalid of invalidStates) {
    const root = await prepareRoot({ streams: [stream("new")], streamers: [streamer("new")], state: invalid });
    const path = resolve(root, "data/generated/digest.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }));
    assert.equal(await readFile(path, "utf8"), before);
  }

  const state = { announced: [] };
  const root = await prepareRoot({ streams: [{ id: 1 }], state });
  const path = resolve(root, "data/generated/digest.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }), /streams\.json/);
  assert.equal(await readFile(path, "utf8"), before);

  await writeFile(resolve(root, "data/generated/streams.json"), "{");
  await assert.rejects(runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }), /JSON/);
  assert.equal(await readFile(path, "utf8"), before);

  const futureRoot = await prepareRoot({
    streams: [],
    state: { lastPostedAt: new Date(NOW.getTime() + 25 * HOUR_MS).toISOString(), announced: [] },
  });
  const futurePath = resolve(futureRoot, "data/generated/digest.json");
  const futureBefore = await readFile(futurePath, "utf8");
  await assert.rejects(
    runDigest({ rootDir: futureRoot, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }),
    /24時間を超えて未来/,
  );
  assert.equal(await readFile(futurePath, "utf8"), futureBefore);
});

test("Webhook失敗とPOST後のstate書込失敗では旧stateを維持して次回再投稿可能にする", async () => {
  const oldState = { lastPostedAt: new Date(NOW.getTime() - 3 * HOUR_MS).toISOString(), announced: [] };
  for (const failure of ["post", "write"] as const) {
    const root = await prepareRoot({ streams: [stream("new")], streamers: [streamer("new")], state: oldState });
    const path = resolve(root, "data/generated/digest.json");
    const before = await readFile(path, "utf8");
    let calls = 0;
    await assert.rejects(runDigest({
      rootDir: root,
      now: NOW,
      iftttWebhookKey: "key",
      youtubeApiKey: "key",
      fetchFn: mockFetch(() => {
        calls += 1;
        return new Response(null, { status: failure === "post" ? 500 : 200 });
      }),
      ...(failure === "write" ? { beforeStateCommit: () => { throw new Error("書込失敗"); } } : {}),
    }));
    assert.equal(calls, 1);
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("dry-runはキーなしで本文を表示するだけで、未知引数はCLIで非0終了する", async () => {
  const root = await prepareRoot({ streams: [stream("new")], streamers: [streamer("new")] });
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => messages.push(String(message));
  try {
    assert.equal(await runDigest({ rootDir: root, now: NOW, dryRun: true, iftttWebhookKey: "", youtubeApiKey: "" }), "dry-run");
  } finally {
    console.log = originalLog;
  }
  assert.match(messages.join("\n"), /配信者 new/);
  await assert.rejects(readFile(resolve(root, "data/generated/digest.json"), "utf8"), /ENOENT/);

  const script = resolve(import.meta.dirname, "../scripts/digest.ts");
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, "--unknown"], { cwd: resolve(import.meta.dirname, "..") });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /未知の引数/);
});
