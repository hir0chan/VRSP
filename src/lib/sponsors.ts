import { getJstDateKey } from "./classify.js";

export interface SponsorEntry {
  id: string;
  name: string;
  url: string;
  descriptionJa: string;
  descriptionEn: string;
  until?: string;
}

const REQUIRED_STRING_FIELDS = [
  "id",
  "name",
  "url",
  "descriptionJa",
  "descriptionEn",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredString(
  entry: Record<string, unknown>,
  field: typeof REQUIRED_STRING_FIELDS[number],
  index: number,
): string {
  const value = entry[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`sponsors[${index}].${field} は空でない文字列が必要です`);
  }
  if (value.trim() !== value) {
    throw new Error(`sponsors[${index}].${field} の前後に空白を含めることはできません`);
  }
  return value;
}

function validateHttpsUrl(value: string, index: number): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`sponsors[${index}].url は有効な HTTPS URL が必要です`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`sponsors[${index}].url は HTTPS URL が必要です`);
  }
}

function validateDateKey(value: string, index: number): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`sponsors[${index}].until は yyyy-MM-dd 形式が必要です`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`sponsors[${index}].until は実在する日付が必要です`);
  }
}

export function parseSponsors(raw: unknown): SponsorEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("sponsors.yaml のルートは配列である必要があります");
  }

  const ids = new Set<string>();
  return raw.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`sponsors[${index}] はオブジェクトである必要があります`);
    }

    const parsed = Object.fromEntries(
      REQUIRED_STRING_FIELDS.map((field) => [
        field,
        parseRequiredString(value, field, index),
      ]),
    ) as Record<typeof REQUIRED_STRING_FIELDS[number], string>;
    validateHttpsUrl(parsed.url, index);

    if (ids.has(parsed.id)) {
      throw new Error(`スポンサー ID "${parsed.id}" が重複しています`);
    }
    ids.add(parsed.id);

    const until = value.until;
    if (until !== undefined) {
      if (typeof until !== "string" || until.trim() !== until) {
        throw new Error(`sponsors[${index}].until は前後空白のない文字列が必要です`);
      }
      validateDateKey(until, index);
    }

    return until === undefined ? parsed : { ...parsed, until };
  });
}

export function filterActiveSponsors(
  entries: SponsorEntry[],
  now: Date,
): SponsorEntry[] {
  const today = getJstDateKey(now);
  return entries.filter((entry) => entry.until === undefined || entry.until >= today);
}
