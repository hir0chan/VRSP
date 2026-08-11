import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterActiveSponsors,
  parseSponsors,
} from "../src/lib/sponsors.js";

const validSponsor = {
  id: "example",
  name: "Example Community",
  url: "https://example.com/community",
  descriptionJa: "日本語の紹介文",
  descriptionEn: "English description",
};

test("正しいエントリを補正せず保持する", () => {
  const raw = [
    validSponsor,
    {
      ...validSponsor,
      id: "limited",
      url: "https://example.com/limited",
      until: "2026-04-30",
    },
    {
      ...validSponsor,
      id: "leap-day",
      url: "https://example.com/leap-day",
      until: "2028-02-29",
    },
  ];

  assert.deepEqual(parseSponsors(raw), raw);
});

test("期限なしのエントリは任意の日付で掲載する", () => {
  const entries = parseSponsors([validSponsor]);
  assert.deepEqual(
    filterActiveSponsors(entries, new Date("2099-12-31T15:00:00.000Z")),
    entries,
  );
});

test("ルート配列と要素オブジェクトを検証する", () => {
  for (const raw of [{}, null, "sponsors"]) {
    assert.throws(() => parseSponsors(raw));
  }
  for (const entry of [null, "sponsor", [], 1]) {
    assert.throws(() => parseSponsors([entry]));
  }
});

test("必須文字列の欠落・空文字・前後空白を拒否する", () => {
  for (const field of ["id", "name", "url", "descriptionJa", "descriptionEn"] as const) {
    const missing = { ...validSponsor } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => parseSponsors([missing]));
    assert.throws(() => parseSponsors([{ ...validSponsor, [field]: "" }]));
    assert.throws(() => parseSponsors([{ ...validSponsor, [field]: ` ${validSponsor[field]}` }]));
    assert.throws(() => parseSponsors([{ ...validSponsor, [field]: `${validSponsor[field]} ` }]));
  }
});

test("HTTPS 以外または不完全な URL を拒否する", () => {
  for (const url of [
    "https://",
    "http://example.com",
    "/community",
    123,
  ]) {
    assert.throws(() => parseSponsors([{ ...validSponsor, url }]));
  }
});

test("重複 ID を拒否する", () => {
  assert.throws(() => parseSponsors([
    validSponsor,
    { ...validSponsor, url: "https://example.org" },
  ]));
});

test("不正な掲載期限を拒否する", () => {
  for (const until of [
    "2026-13-99",
    "20260811",
    "2026-02-29",
    " 2026-08-11",
    "2026-08-11 ",
    20260811,
    null,
  ]) {
    assert.throws(() => parseSponsors([{ ...validSponsor, until }]));
  }
});

test("掲載期限当日は JST の終端まで掲載する", () => {
  const entries = parseSponsors([{ ...validSponsor, until: "2026-08-11" }]);
  assert.equal(
    filterActiveSponsors(entries, new Date("2026-08-11T14:59:59.999Z")).length,
    1,
  );
  assert.equal(
    filterActiveSponsors(entries, new Date("2026-08-11T15:00:00.000Z")).length,
    0,
  );
});

test("無効な現在日時を拒否する", () => {
  const entries = parseSponsors([validSponsor]);
  assert.throws(
    () => filterActiveSponsors(entries, new Date(Number.NaN)),
    RangeError,
  );
});
