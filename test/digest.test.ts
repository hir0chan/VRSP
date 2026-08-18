import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  composeDigest,
  countLiveJapanese,
  postToIfttt,
  runDigest,
  sanitizePostText,
  selectFeatured,
  shouldPost,
  streamKey,
  truncateWeighted,
  weightedLength,
  weightedPostLength,
} from "../scripts/digest.js";
import type { DigestState, Stream, Streamer } from "../scripts/models.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const SITE_URL = "https://vcha-antenna.com/";

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
    await writeFile(
      resolve(generated, "digest.json"),
      typeof options.state === "string" ? options.state : JSON.stringify(options.state),
    );
  }
  return root;
}

async function readState(root: string): Promise<DigestState> {
  return JSON.parse(await readFile(resolve(root, "data/generated/digest.json"), "utf8")) as DigestState;
}

test("JP liveだけを選び、複合キーで直前の配信を避け、乱数を注入できる", () => {
  const youtube = stream("same");
  const twitch = stream("same", { platform: "twitch" });
  const values = [
    youtube,
    twitch,
    stream("non-ja", { isJapanese: false }),
    stream("upcoming", { status: "upcoming" }),
  ];
  assert.equal(streamKey(youtube), "youtube:same");
  assert.equal(streamKey(twitch), "twitch:same");
  assert.equal(streamKey(selectFeatured(values, "youtube:same", () => 0)!), "twitch:same");
  assert.equal(streamKey(selectFeatured(values, "twitch:same", () => 0)!), "youtube:same");
  assert.equal(countLiveJapanese(values), 2);
});

test("候補1件は直前と同じでも選び、0件はundefinedを返す", () => {
  const only = stream("only");
  assert.equal(selectFeatured([only], "youtube:only", () => 0), only);
  assert.equal(selectFeatured([stream("ended", { status: "ended" })], undefined, () => 0), undefined);
  assert.throws(() => selectFeatured([only], undefined, () => 1), /0以上1未満/);
});

test("空にサニタイズされるタイトルを除外し、全滅時だけ名前用の候補へ退避する", () => {
  const empty = stream("empty", { title: "\n\u0000\u202E" });
  const valid = stream("valid", { title: "配信タイトル" });
  assert.equal(selectFeatured([empty, valid], undefined, () => 0), valid);
  assert.equal(selectFeatured([empty], undefined, () => 0), empty);
});

test("サニタイズは長さを変えずに制御文字・書式制御・誘導記号・URL風トークンを無害化する", () => {
  const long = "長".repeat(100);
  assert.equal(sanitizePostText(long), long);
  const value = sanitizePostText(
    "  A\n\u0000\u202E @user ＠user #tag ＃tag https://evil.example/a ftp：／／evil．example quote\"  ",
  );
  assert.doesNotMatch(value, /[\p{Cc}\p{Cf}@＠#＃.．。｡]/u);
  assert.doesNotMatch(value, /\s{2,}/u);
  assert.doesNotMatch(value, /https?:\/\//u);
  assert.match(value, /https・\/\/evil・example/);
  assert.match(value, /quote"/);
});

test("重み付き切り詰めは絵文字の書記素を壊さず末尾に省略記号を付ける", () => {
  const value = truncateWeighted(`日本語😀e\u0301${"長".repeat(100)}`, 20);
  assert.equal(weightedLength(value) <= 20, true);
  assert.equal(value.endsWith("…"), true);
  assert.equal(weightedLength("abcé"), 4);
  assert.equal(weightedLength("日本😀"), 6);
});

test("新テンプレートは生の配信者名を?q=へエンコードし、タイトルを残余予算で280以内にする", () => {
  const featured = stream("featured", { title: `引用符\" @告知 #tag https://evil.example/${"長😀".repeat(200)}` });
  const rawName = `配信者 #A ${"名".repeat(100)}`;
  const text = composeDigest(featured, 12, [streamer("featured", rawName)]);
  assert.match(text, /^👉️ 今おすすめのVRChat配信は\?\n/);
  assert.equal(text.split("\n")[2], `${SITE_URL}?q=${encodeURIComponent(rawName)}`);
  assert.match(text, /現在12件がライブ配信中👀\n#VRChat #ぶいちゃ配信アンテナ$/);
  assert.doesNotMatch(text.split("\n")[1] ?? "", /[@#]|https?:\/\//u);
  assert.equal(weightedPostLength(text) <= 280, true);
  assert.match(text.split("\n")[1] ?? "", /…\(.*…\)$/u);
});

test("本文途中の長いURLを実長でなく23として数える", () => {
  const url = `${SITE_URL}?q=${"a".repeat(500)}`;
  const text = `前\n${url}\n後`;
  assert.equal(weightedPostLength(text), weightedLength("前\n") + 23 + weightedLength("\n後"));
  assert.equal(weightedLength(text) > weightedPostLength(text), true);
});

test("名前が空ならタイトルだけとトップリンク、タイトルが空なら配信者名だけを使う", () => {
  const noName = composeDigest(stream("no-name"), 1, [streamer("no-name", "\n\u202E")]);
  assert.equal(noName.split("\n")[1], "VRChat no-name");
  assert.equal(noName.split("\n")[2], SITE_URL);

  const noTitle = composeDigest(stream("no-title", { title: "\n\u0000" }), 1, [streamer("no-title", "配信者")]);
  assert.equal(noTitle.split("\n")[1], "配信者");
  assert.match(noTitle.split("\n")[2] ?? "", /\?q=%E9%85%8D%E4%BF%A1%E8%80%85$/);
});

test("投稿間隔は120分ちょうどを許可し、未来24時間以内はスキップ、超過は拒否する", () => {
  const state = (offsetMs: number): DigestState => ({
    lastPostedAt: new Date(NOW.getTime() + offsetMs).toISOString(),
  });
  assert.equal(shouldPost({}, NOW), true);
  assert.equal(shouldPost(state(-120 * 60 * 1_000 + 1_000), NOW), false);
  assert.equal(shouldPost(state(-120 * 60 * 1_000), NOW), true);
  assert.equal(shouldPost(state(HOUR_MS), NOW), false);
  assert.equal(shouldPost(state(24 * HOUR_MS), NOW), false);
  assert.throws(() => shouldPost(state(25 * HOUR_MS), NOW), /24時間を超えて未来/);
  assert.throws(() => shouldPost({ lastPostedAt: "invalid" }, NOW), /不正な日時/);
});

test("IFTTT POSTはJSON・redirect error・15秒タイムアウトを使い、失敗情報を秘匿する", async () => {
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

test("stateなしの初回でもliveがあれば即投稿して新形式stateを作る", async () => {
  const featured = stream("first");
  const root = await prepareRoot({ streams: [featured], streamers: [streamer("first")] });
  let postedText = "";
  const result = await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "ifttt-key",
    youtubeApiKey: "youtube-key",
    randomFn: () => 0,
    fetchFn: mockFetch((_url, init) => {
      postedText = (JSON.parse(String(init?.body)) as { value1: string }).value1;
      return new Response(null, { status: 204 });
    }),
  });
  assert.equal(result, "posted");
  assert.match(postedText, /VRChat first\(配信者 first\)/);
  assert.deepEqual(await readState(root), {
    lastPostedAt: NOW.toISOString(),
    lastFeaturedId: "youtube:first",
  });
});

test("stateなしでliveがなければstateを作らずスキップする", async () => {
  const root = await prepareRoot();
  assert.equal(await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "key",
    youtubeApiKey: "key",
  }), "skipped");
  await assert.rejects(readFile(resolve(root, "data/generated/digest.json"), "utf8"), /ENOENT/);
});

test("旧announcedは型を問わず無視し、投稿後に新形式だけを書き戻す", async () => {
  const oldAt = new Date(NOW.getTime() - 3 * HOUR_MS).toISOString();
  const root = await prepareRoot({
    streams: [stream("old-state")],
    streamers: [streamer("old-state")],
    state: { lastPostedAt: oldAt, announced: { broken: true } },
  });
  assert.equal(await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "key",
    youtubeApiKey: "key",
    fetchFn: mockFetch(() => new Response(null, { status: 200 })),
  }), "posted");
  assert.deepEqual(await readState(root), {
    lastPostedAt: NOW.toISOString(),
    lastFeaturedId: "youtube:old-state",
  });
});

test("2時間経過後は新規判定なしで同じ1件を再投稿する", async () => {
  const oldAt = new Date(NOW.getTime() - 2 * HOUR_MS).toISOString();
  const root = await prepareRoot({
    streams: [stream("repeat")],
    streamers: [streamer("repeat")],
    state: { lastPostedAt: oldAt, lastFeaturedId: "youtube:repeat" },
  });
  let calls = 0;
  assert.equal(await runDigest({
    rootDir: root,
    now: NOW,
    iftttWebhookKey: "key",
    youtubeApiKey: "key",
    fetchFn: mockFetch(() => {
      calls += 1;
      return new Response(null, { status: 200 });
    }),
  }), "posted");
  assert.equal(calls, 1);
});

test("live 0件または投稿間隔前はstateを変更せずスキップする", async () => {
  for (const options of [
    { streams: [] as Stream[], streamers: [] as Streamer[], offset: -3 * HOUR_MS },
    { streams: [stream("early")], streamers: [streamer("early")], offset: -119 * 60 * 1_000 },
  ]) {
    const state = { lastPostedAt: new Date(NOW.getTime() + options.offset).toISOString() };
    const root = await prepareRoot({ streams: options.streams, streamers: options.streamers, state });
    const path = resolve(root, "data/generated/digest.json");
    const before = await readFile(path, "utf8");
    assert.equal(await runDigest({
      rootDir: root,
      now: NOW,
      iftttWebhookKey: "key",
      youtubeApiKey: "key",
      fetchFn: mockFetch(() => { throw new Error("投稿されるべきではありません"); }),
    }), "skipped");
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("旧stateはlastFeaturedIdの非文字列とlastPostedAtの不正値だけを拒否して保つ", async () => {
  const invalidStates: unknown[] = [
    "{",
    null,
    { lastFeaturedId: 1, announced: [] },
    { lastPostedAt: "invalid", announced: [] },
  ];
  for (const invalid of invalidStates) {
    const root = await prepareRoot({ streams: [stream("invalid")], streamers: [streamer("invalid")], state: invalid });
    const path = resolve(root, "data/generated/digest.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }));
    assert.equal(await readFile(path, "utf8"), before);
  }

  const futureRoot = await prepareRoot({
    state: { lastPostedAt: new Date(NOW.getTime() + 25 * HOUR_MS).toISOString(), announced: "ignored" },
  });
  const futurePath = resolve(futureRoot, "data/generated/digest.json");
  const before = await readFile(futurePath, "utf8");
  await assert.rejects(
    runDigest({ rootDir: futureRoot, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }),
    /24時間を超えて未来/,
  );
  assert.equal(await readFile(futurePath, "utf8"), before);
});

test("各キーの片方が欠ければ入力もstateも読まず正常スキップする", async () => {
  for (const keys of [
    { iftttWebhookKey: "", youtubeApiKey: "youtube" },
    { iftttWebhookKey: "ifttt", youtubeApiKey: "" },
  ]) {
    const root = await mkdtemp(resolve(tmpdir(), "vrsp-digest-no-input-"));
    assert.equal(await runDigest({ rootDir: root, now: NOW, ...keys }), "skipped-keys");
    await assert.rejects(readFile(resolve(root, "data/generated/digest.json"), "utf8"), /ENOENT/);
  }
});

test("Webhook失敗とPOST後のstate書込失敗では旧stateを維持する", async () => {
  const oldState = { lastPostedAt: new Date(NOW.getTime() - 3 * HOUR_MS).toISOString() };
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

test("入力JSON破損を拒否してstateを保つ", async () => {
  const state = { lastPostedAt: new Date(NOW.getTime() - 3 * HOUR_MS).toISOString() };
  const root = await prepareRoot({ streams: [{ id: 1 }], state });
  const path = resolve(root, "data/generated/digest.json");
  const before = await readFile(path, "utf8");
  await assert.rejects(
    runDigest({ rootDir: root, now: NOW, iftttWebhookKey: "key", youtubeApiKey: "key" }),
    /streams\.json/,
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("dry-runはキーなしで新本文を表示するだけで、未知引数はCLIで非0終了する", async () => {
  const root = await prepareRoot({ streams: [stream("dry")], streamers: [streamer("dry")] });
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => messages.push(String(message));
  try {
    assert.equal(await runDigest({ rootDir: root, now: NOW, dryRun: true, randomFn: () => 0 }), "dry-run");
  } finally {
    console.log = originalLog;
  }
  assert.match(messages.join("\n"), /今おすすめのVRChat配信/);
  assert.match(messages.join("\n"), /\?q=/);
  assert.equal(weightedPostLength(messages.join("\n")) <= 280, true);
  await assert.rejects(readFile(resolve(root, "data/generated/digest.json"), "utf8"), /ENOENT/);

  const script = resolve(import.meta.dirname, "../scripts/digest.ts");
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, "--unknown"], {
      cwd: resolve(import.meta.dirname, ".."),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /未知の引数/);
});
