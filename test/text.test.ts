import test from "node:test";
import assert from "node:assert/strict";
import { splitForWeChat, utf8Bytes } from "../src/util/text.js";

test("splitForWeChat packs short blocks", () => {
  assert.deepEqual(splitForWeChat("a\n\nb", 10), ["a\n\nb"]);
});

test("splitForWeChat respects utf8 byte limits", () => {
  const chunks = splitForWeChat("你好".repeat(20), 20);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(utf8Bytes(chunk) <= 20);
  }
});

test("splitForWeChat returns no empty chunks", () => {
  assert.deepEqual(splitForWeChat(" \n\n "), []);
});
