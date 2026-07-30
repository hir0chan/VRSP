import type { Stream, Streamer } from "../../scripts/models.js";

export interface JoinedStream extends Stream {
  streamer: Streamer;
}

export interface UpcomingGroup {
  key: string;
  label: string;
  streams: JoinedStream[];
}

export interface ClassifiedStreams {
  live: JoinedStream[];
  today: JoinedStream[];
  upcoming: UpcomingGroup[];
}

type Warn = (message: string) => void;

const JST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const JST_LABEL_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
  weekday: "short",
});

function toValidDate(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getJstDateKey(date: Date): string {
  const parts = JST_DATE_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("JST の日付を取得できませんでした");
  }
  return `${year}-${month}-${day}`;
}

function joinStreams(
  streams: Stream[],
  streamers: Streamer[],
  warn: Warn,
): JoinedStream[] {
  const byId = new Map(streamers.map((streamer) => [streamer.id, streamer]));
  return streams.flatMap((stream) => {
    const streamer = byId.get(stream.streamerId);
    if (streamer === undefined) {
      warn(`未知の streamerId "${stream.streamerId}" の配信 "${stream.id}" をスキップしました`);
      return [];
    }
    return [{ ...stream, streamer }];
  });
}

function startTime(stream: JoinedStream): number {
  const value = stream.scheduledStart ?? stream.actualStart;
  return toValidDate(value)?.getTime() ?? Number.POSITIVE_INFINITY;
}

function byStartTime(left: JoinedStream, right: JoinedStream): number {
  return startTime(left) - startTime(right);
}

function groupUpcoming(streams: JoinedStream[]): UpcomingGroup[] {
  const dated = new Map<string, JoinedStream[]>();
  const undated: JoinedStream[] = [];

  for (const stream of streams) {
    const date = toValidDate(stream.scheduledStart);
    if (date === undefined) {
      undated.push(stream);
      continue;
    }
    const key = getJstDateKey(date);
    const group = dated.get(key) ?? [];
    group.push(stream);
    dated.set(key, group);
  }

  const groups = [...dated.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => {
      const firstStart = toValidDate(group[0]?.scheduledStart);
      if (firstStart === undefined) {
        throw new Error("日付グループの生成に失敗しました");
      }
      return {
        key,
        label: JST_LABEL_FORMATTER.format(firstStart),
        streams: group.sort(byStartTime),
      };
    });

  if (undated.length > 0) {
    groups.push({
      key: "undated",
      label: "日付未定",
      streams: undated.sort(byStartTime),
    });
  }
  return groups;
}

export function classifyStreams(
  streams: Stream[],
  streamers: Streamer[],
  now: Date,
  warn: Warn = console.warn,
): ClassifiedStreams {
  const todayKey = getJstDateKey(now);
  const joined = joinStreams(streams, streamers, warn);
  const live = joined
    .filter((stream) => stream.status === "live")
    .sort(byStartTime);
  const upcoming = joined.filter((stream) => stream.status === "upcoming");
  const today = upcoming
    .filter((stream) => {
      const date = toValidDate(stream.scheduledStart);
      return date !== undefined && getJstDateKey(date) === todayKey;
    })
    .sort(byStartTime);
  const later = upcoming.filter((stream) => !today.includes(stream));

  return { live, today, upcoming: groupUpcoming(later) };
}
