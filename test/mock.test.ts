import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { generateMockStreams, MOCK_STREAMERS } from "../scripts/mock.js";
import type { GeneratedStreamers, GeneratedStreams } from "../scripts/models.js";
import { writeGeneratedFiles } from "../scripts/update.js";
import { classifyStreams } from "../src/lib/classify.js";

const noopConsole = (): void => undefined;
console.warn = noopConsole;
console.error = noopConsole;
console.log = noopConsole;

test("固定 now と内蔵チャンネルから既定件数を決定的に生成する", () => {
  const now = new Date("2026-07-30T03:00:00.000Z");
  const first = generateMockStreams(now);
  const second = generateMockStreams(now);
  assert.deepEqual(first, second);
  assert.equal(first.filter((stream) => stream.status === "live").length, 2);
  assert.equal(first.filter((stream) => stream.status === "upcoming").length, 7);
  assert.equal(first.filter((stream) => stream.status === "ended").length, 2);
  assert.equal(new Set(first.map((stream) => stream.streamerId)).size > 1, true);
  assert.equal(first.every((stream) => typeof stream.isJapanese === "boolean"), true);
  assert.equal(first.filter((stream) => stream.isJapanese === false).length, 2);
  assert.equal(first.filter((stream) => stream.isJapanese === false).every((stream) => /^VRChat [A-Za-z ]+ #\d+$/.test(stream.title)), true);
});

test("live 0件と JST 日付終了直前の upcoming を生成できる", () => {
  const now = new Date("2026-07-30T14:59:59.000Z");
  const streams = generateMockStreams(now, {
    liveCount: 0,
    todayUpcomingCount: 3,
    futureUpcomingCount: 0,
    endedCount: 0,
  });
  const classified = classifyStreams(streams, MOCK_STREAMERS, now);
  assert.equal(classified.live.length, 0);
  assert.equal(classified.today.length, 3);
});

test("rename 前の失敗では既存 generated を変更しない", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-atomic-"));
  const outputDir = resolve(root, "data/generated");
  await mkdir(outputDir, { recursive: true });
  const paths = {
    streams: resolve(outputDir, "streams.json"),
    streamers: resolve(outputDir, "streamers.json"),
  };
  await writeFile(paths.streams, "old streams");
  await writeFile(paths.streamers, "old streamers");
  const streamsPayload: GeneratedStreams = { updatedAt: "2026-07-30T03:00:00.000Z", tracked: [], streams: [] };
  const streamersPayload: GeneratedStreamers = { updatedAt: "2026-07-30T03:00:00.000Z", streamers: [] };
  await assert.rejects(
    writeGeneratedFiles(paths, streamsPayload, streamersPayload, () => { throw new Error("simulated write failure"); }),
    /simulated write failure/,
  );
  assert.equal(await readFile(paths.streams, "utf8"), "old streams");
  assert.equal(await readFile(paths.streamers, "utf8"), "old streamers");
});
