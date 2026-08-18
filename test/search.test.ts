import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasVisibleCard,
  isCardVisible,
  type SearchCard,
  type SearchFilters,
} from "../src/lib/search.js";

const youtubeJa: SearchCard = {
  isJapanese: true,
  platform: "youtube",
  searchText: "vrchat world alice",
};
const twitchEn: SearchCard = {
  isJapanese: false,
  platform: "twitch",
  searchText: "english vrchat bob",
};
const niconicoJa: SearchCard = {
  isJapanese: true,
  platform: "niconico",
  searchText: "quoted \"title\" carol",
};

test("platform・日本語のみ・検索語の全組み合わせをANDで判定する", () => {
  const cards = [youtubeJa, twitchEn, niconicoJa];
  const platforms: SearchFilters["platform"][] = [undefined, "youtube", "twitch", "niconico"];
  const japaneseValues = [false, true];
  const queries = ["", "VRCHAT", "alice", "bob", "missing"];

  for (const platform of platforms) {
    for (const japaneseOnly of japaneseValues) {
      for (const query of queries) {
        const filters: SearchFilters = {
          japaneseOnly,
          ...(platform === undefined ? {} : { platform }),
          query,
        };
        for (const card of cards) {
          const expected = (!japaneseOnly || card.isJapanese)
            && (platform === undefined || card.platform === platform)
            && card.searchText.includes(query.toLowerCase());
          assert.equal(isCardVisible(card, filters), expected);
        }
      }
    }
  }
});

test("検索解除時はフィルタなしなら全件表示になり、既存フィルタだけは維持する", () => {
  assert.equal(isCardVisible(twitchEn, { japaneseOnly: false, query: "" }), true);
  assert.equal(isCardVisible(twitchEn, { japaneseOnly: true, query: "" }), false);
  assert.equal(isCardVisible(youtubeJa, { japaneseOnly: false, platform: "twitch", query: "" }), false);
});

test("混在する日付グループは表示可能カードが1件でもあれば空ではない", () => {
  const group = [youtubeJa, twitchEn];
  assert.equal(hasVisibleCard(group, { japaneseOnly: true, platform: "youtube", query: "alice" }), true);
  assert.equal(hasVisibleCard(group, { japaneseOnly: false, platform: "twitch", query: "bob" }), true);
  assert.equal(hasVisibleCard(group, { japaneseOnly: true, platform: "twitch", query: "bob" }), false);
  assert.equal(hasVisibleCard(group, { japaneseOnly: false, platform: "niconico", query: "" }), false);
});

test("検索一致カードも既存フィルタで隠れ、引用符やXSS風検索語は単なる文字列として扱う", () => {
  assert.equal(isCardVisible(youtubeJa, {
    japaneseOnly: false,
    platform: "twitch",
    query: "alice",
  }), false);
  assert.equal(isCardVisible(niconicoJa, {
    japaneseOnly: false,
    query: "\"title\"",
  }), true);
  assert.equal(isCardVisible(niconicoJa, {
    japaneseOnly: false,
    query: "\"><img src=x onerror=alert(1)>",
  }), false);
});
