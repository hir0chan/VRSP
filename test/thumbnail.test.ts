import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveThumbnailUrl } from "../src/lib/thumbnail.js";

const noopConsole = (): void => undefined;
console.warn = noopConsole;
console.error = noopConsole;
console.log = noopConsole;

test("HTTP/HTTPS の絶対サムネイル URL はそのまま返す", () => {
  assert.equal(
    resolveThumbnailUrl("https://i.ytimg.com/vi/example/high.jpg", "/VRSP/"),
    "https://i.ytimg.com/vi/example/high.jpg",
  );
  assert.equal(
    resolveThumbnailUrl("http://example.com/thumbnail.jpg", "/VRSP/"),
    "http://example.com/thumbnail.jpg",
  );
});

test("相対サムネイルパスには BASE_URL を前置する", () => {
  assert.equal(
    resolveThumbnailUrl("images/thumbnail-1.svg", "/VRSP/"),
    "/VRSP/images/thumbnail-1.svg",
  );
});

test("空文字には BASE_URL のみを返す", () => {
  assert.equal(resolveThumbnailUrl("", "/VRSP/"), "/VRSP/");
});
