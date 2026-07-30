import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stream, Streamer } from "../scripts/models.js";
import {
  classifyStreams,
  getJstDateKey,
} from "../src/lib/classify.js";

const streamers: Streamer[] = [
  {
    id: "known",
    name: "既知の配信者",
    youtubeChannelId: "UC_TEST",
    enabled: true,
  },
];

function upcoming(id: string, scheduledStart?: string): Stream {
  const stream: Stream = {
    id,
    streamerId: "known",
    title: id,
    thumbnail: "images/thumbnail-1.svg",
    url: `https://example.com/${id}`,
    status: "upcoming",
  };
  return scheduledStart === undefined
    ? stream
    : { ...stream, scheduledStart };
}

test("JST 00:00 の前後を別日として分類する", () => {
  const now = new Date("2026-07-30T15:00:00.000Z");
  const result = classifyStreams(
    [
      upcoming("before-midnight", "2026-07-30T14:59:59.999Z"),
      upcoming("at-midnight", "2026-07-30T15:00:00.000Z"),
      upcoming("after-midnight", "2026-07-30T15:00:00.001Z"),
    ],
    streamers,
    now,
  );

  assert.deepEqual(
    result.today.map((stream) => stream.id),
    ["at-midnight", "after-midnight"],
  );
  assert.equal(result.upcoming[0]?.key, "2026-07-30");
});

test("23:50 開始は日付を跨いでも開始日の TODAY に残る", () => {
  const result = classifyStreams(
    [upcoming("late", "2026-07-31T14:50:00.000Z")],
    streamers,
    new Date("2026-07-31T14:55:00.000Z"),
  );

  assert.equal(result.today[0]?.id, "late");
  assert.equal(result.upcoming.length, 0);
});

test("月末と年末の日付キーを正しく繰り上げる", () => {
  assert.equal(getJstDateKey(new Date("2026-01-31T15:00:00.000Z")), "2026-02-01");
  assert.equal(getJstDateKey(new Date("2026-12-31T15:00:00.000Z")), "2027-01-01");

  const result = classifyStreams(
    [
      upcoming("year-end", "2026-12-31T14:59:59.999Z"),
      upcoming("new-year", "2026-12-31T15:00:00.000Z"),
    ],
    streamers,
    new Date("2026-12-31T14:00:00.000Z"),
  );
  assert.deepEqual(result.today.map((stream) => stream.id), ["year-end"]);
  assert.equal(result.upcoming[0]?.key, "2027-01-01");
});

test("scheduledStart 欠落は UPCOMING の日付未定末尾へ送る", () => {
  const result = classifyStreams(
    [
      upcoming("undated"),
      upcoming("future", "2026-08-02T03:00:00.000Z"),
    ],
    streamers,
    new Date("2026-07-30T03:00:00.000Z"),
  );

  assert.deepEqual(
    result.upcoming.map((group) => group.key),
    ["2026-08-02", "undated"],
  );
  assert.equal(result.upcoming[1]?.streams[0]?.id, "undated");
});

test("actualStart 欠落の live もカード対象に残す", () => {
  const live: Stream = {
    ...upcoming("live-without-start"),
    status: "live",
  };
  const result = classifyStreams(
    [live],
    streamers,
    new Date("2026-07-30T03:00:00.000Z"),
  );
  assert.equal(result.live[0]?.id, live.id);
  assert.equal(result.live[0]?.actualStart, undefined);
});

test("未知の streamerId は警告してスキップする", () => {
  const warnings: string[] = [];
  const unknown = { ...upcoming("unknown"), streamerId: "missing" };
  const result = classifyStreams(
    [unknown],
    streamers,
    new Date("2026-07-30T03:00:00.000Z"),
    (message) => warnings.push(message),
  );

  assert.deepEqual(result, { live: [], today: [], upcoming: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /missing.*unknown/);
});
