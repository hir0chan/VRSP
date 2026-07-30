import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { generateMockStreams } from "../scripts/mock.js";
import type {
  GeneratedStreamers,
  GeneratedStreams,
  Streamer,
} from "../scripts/models.js";
import { writeGeneratedFiles } from "../scripts/update.js";
import { classifyStreams } from "../src/lib/classify.js";

const streamers: Streamer[] = Array.from({ length: 5 }, (_, index) => ({
  id: `streamer-${index}`,
  name: `配信者${index}`,
  youtubeChannelId: `UC_${index}`,
  enabled: true,
}));

test("固定 now から既定件数を決定的に生成する", () => {
  const now = new Date("2026-07-30T03:00:00.000Z");
  const first = generateMockStreams(streamers, now);
  const second = generateMockStreams(streamers, now);

  assert.deepEqual(first, second);
  assert.equal(first.filter((stream) => stream.status === "live").length, 2);
  assert.equal(first.filter((stream) => stream.status === "upcoming").length, 7);
  assert.equal(first.filter((stream) => stream.status === "ended").length, 2);
  assert.equal(new Set(first.map((stream) => stream.id)).size, first.length);
});

test("live 0件シナリオは分類後も NOW ON LIVE が空になる", () => {
  const now = new Date("2026-07-30T03:00:00.000Z");
  const streams = generateMockStreams(streamers, now, {
    liveCount: 0,
    todayUpcomingCount: 1,
    futureUpcomingCount: 0,
    endedCount: 0,
  });
  assert.equal(classifyStreams(streams, streamers, now).live.length, 0);
});

test("JST の日付終了直前でも本日 upcoming を指定件数生成する", () => {
  const now = new Date("2026-07-30T14:59:59.000Z");
  const streams = generateMockStreams(streamers, now, {
    liveCount: 0,
    todayUpcomingCount: 3,
    futureUpcomingCount: 0,
    endedCount: 0,
  });
  assert.equal(classifyStreams(streams, streamers, now).today.length, 3);
});

test("rename 前の失敗では既存 generated を変更しない", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vrsp-atomic-"));
  const outputDir = resolve(root, "data/generated");
  await mkdir(outputDir, { recursive: true });
  const paths = {
    streams: resolve(outputDir, "streams.json"),
    streamers: resolve(outputDir, "streamers.json"),
  };
  const originalStreams = '{"marker":"old-streams"}\n';
  const originalStreamers = '{"marker":"old-streamers"}\n';
  await writeFile(paths.streams, originalStreams);
  await writeFile(paths.streamers, originalStreamers);

  const streamsPayload: GeneratedStreams = {
    updatedAt: "2026-07-30T03:00:00.000Z",
    streams: [],
  };
  const streamersPayload: GeneratedStreamers = {
    updatedAt: "2026-07-30T03:00:00.000Z",
    streamers: [],
  };

  await assert.rejects(
    writeGeneratedFiles(paths, streamsPayload, streamersPayload, () => {
      throw new Error("simulated write failure");
    }),
    /simulated write failure/,
  );
  assert.equal(await readFile(paths.streams, "utf8"), originalStreams);
  assert.equal(await readFile(paths.streamers, "utf8"), originalStreamers);
});

test("不正な streamers.yaml は非0終了し既存 generated を維持する", async (context) => {
  const invalidCases = [
    {
      name: "id 重複",
      yaml: "- id: duplicate\n  name: A\n  youtubeChannelId: UC_A\n  enabled: true\n- id: duplicate\n  name: B\n  youtubeChannelId: UC_B\n  enabled: true\n",
    },
    {
      name: "必須フィールド欠落",
      yaml: "- id: missing-name\n  youtubeChannelId: UC_A\n  enabled: true\n",
    },
    {
      name: "型不正",
      yaml: "- id: wrong-type\n  name: A\n  youtubeChannelId: UC_A\n  enabled: yes\n",
    },
  ];

  for (const invalidCase of invalidCases) {
    await context.test(invalidCase.name, async () => {
      const root = await mkdtemp(resolve(tmpdir(), "vrsp-invalid-"));
      const generatedDir = resolve(root, "data/generated");
      await mkdir(generatedDir, { recursive: true });
      await writeFile(resolve(root, "data/streamers.yaml"), invalidCase.yaml);
      const streamsPath = resolve(generatedDir, "streams.json");
      const streamersPath = resolve(generatedDir, "streamers.json");
      await writeFile(streamsPath, "old streams");
      await writeFile(streamersPath, "old streamers");

      const result = spawnSync(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        [resolve(process.cwd(), "scripts/update.ts")],
        { cwd: root, encoding: "utf8" },
      );

      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /更新に失敗しました/);
      assert.equal(await readFile(streamsPath, "utf8"), "old streams");
      assert.equal(await readFile(streamersPath, "utf8"), "old streamers");
    });
  }
});
