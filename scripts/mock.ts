import type { Status, Stream, Streamer } from "./models.js";

export interface MockOptions {
  liveCount?: number;
  todayUpcomingCount?: number;
  futureUpcomingCount?: number;
  endedCount?: number;
}

interface MockScenario {
  status: Status;
  count: number;
  phase?: "today" | "future";
}

const DEFAULT_COUNTS: Required<MockOptions> = {
  liveCount: 2,
  todayUpcomingCount: 3,
  futureUpcomingCount: 4,
  endedCount: 2,
};

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function nextJstMidnight(date: Date): number {
  const jstOffset = 9 * 60 * 60_000;
  const local = new Date(date.getTime() + jstOffset);
  return (
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + 1,
    ) - jstOffset
  );
}

function assertCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} は0以上の整数で指定してください`);
  }
}

function createStream(
  streamer: Streamer,
  status: Status,
  sequence: number,
  now: Date,
  scenarioIndex: number,
  phase?: "today" | "future",
  phaseCount?: number,
): Stream {
  const id = `mock-${status}-${scenarioIndex + 1}`;
  const common: Stream = {
    id,
    streamerId: streamer.id,
    title: `${streamer.name}の${status === "live" ? "ライブ配信" : status === "ended" ? "アーカイブ" : "配信予定"} #${sequence + 1}`,
    thumbnail: `images/thumbnail-${(scenarioIndex % 3) + 1}.svg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    status,
  };

  if (status === "live") {
    return {
      ...common,
      scheduledStart: addMinutes(now, -(45 + sequence * 20)),
      actualStart: addMinutes(now, -(35 + sequence * 20)),
      viewers: 128 + sequence * 317,
    };
  }

  if (status === "ended") {
    return {
      ...common,
      scheduledStart: addMinutes(now, -(360 + sequence * 120)),
      actualStart: addMinutes(now, -(350 + sequence * 120)),
      actualEnd: addMinutes(now, -(230 + sequence * 120)),
    };
  }

  if (phase === "today") {
    const count = phaseCount ?? 1;
    const remaining = nextJstMidnight(now) - now.getTime();
    const scheduled = now.getTime() + (remaining * (sequence + 1)) / (count + 1);
    return { ...common, scheduledStart: new Date(scheduled).toISOString() };
  }
  return {
    ...common,
    scheduledStart: addMinutes(now, 1_440 + sequence * 360),
  };
}

export function generateMockStreams(
  streamers: Streamer[],
  now: Date,
  options: MockOptions = {},
): Stream[] {
  if (streamers.length === 0) {
    return [];
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error("now は有効な日時で指定してください");
  }

  const counts = { ...DEFAULT_COUNTS, ...options };
  for (const [name, count] of Object.entries(counts)) {
    assertCount(count, name);
  }

  const scenarios: MockScenario[] = [
    { status: "live", count: counts.liveCount },
    { status: "upcoming", count: counts.todayUpcomingCount, phase: "today" },
    { status: "upcoming", count: counts.futureUpcomingCount, phase: "future" },
    { status: "ended", count: counts.endedCount },
  ];

  let globalIndex = 0;
  return scenarios.flatMap((scenario) =>
    Array.from({ length: scenario.count }, (_, sequence) => {
      const streamer = streamers[globalIndex % streamers.length];
      if (streamer === undefined) {
        throw new Error("配信者の選択に失敗しました");
      }
      const stream = createStream(
        streamer,
        scenario.status,
        sequence,
        now,
        globalIndex,
        scenario.phase,
        scenario.count,
      );
      globalIndex += 1;
      return stream;
    }),
  );
}
