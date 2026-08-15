export type Status = "upcoming" | "live" | "ended";

export interface Streamer {
  id: string;
  name: string;
  // Twitch でも既存 JSON 形式を維持するため、プラットフォーム側のユーザー ID を格納する。
  youtubeChannelId: string;
  enabled: boolean;
}

export interface Stream {
  id: string;
  streamerId: string;
  title: string;
  thumbnail: string;
  url: string;
  status: Status;
  scheduledStart?: string;
  actualStart?: string;
  actualEnd?: string;
  viewers?: number;
  isJapanese?: boolean;
  platform?: "youtube" | "twitch" | "niconico";
}

export interface GeneratedStreams {
  updatedAt: string;
  tracked: Stream[];
  streams: Stream[];
}

export interface GeneratedStreamers {
  updatedAt: string;
  streamers: Streamer[];
}

export interface DiscoveryState {
  discoveryAttemptedAt: string;
  discoveredAt?: string;
}

export interface AnnouncedEntry {
  id: string;
  at: string;
}

export interface DigestState {
  lastPostedAt?: string;
  announced: AnnouncedEntry[];
}
