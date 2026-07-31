export type Status = "upcoming" | "live" | "ended";

export interface Streamer {
  id: string;
  name: string;
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
