import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractArtifactPaths, isImageArtifactRequest, isPlaceholderArtifactReply, stripArtifactDirectives } from "../src/bridge/artifacts.js";

test("extractArtifactPaths finds existing artifact directives", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-artifact-"));
  const file = path.join(tmp, "poster.png");
  fs.writeFileSync(file, "fake");
  const text = `已生成\nARTIFACT: ${file}`;
  assert.deepEqual(extractArtifactPaths(text, tmp), [file]);
  assert.equal(stripArtifactDirectives(text), "已生成");
});

test("artifact helpers detect image requests and placeholder replies", () => {
  assert.equal(isImageArtifactRequest("生成北戴河旅游海报"), true);
  assert.equal(isImageArtifactRequest("查一下天气"), false);
  assert.equal(isPlaceholderArtifactReply("我会用 imagegen 技能生成一张位图旅游海报。"), true);
});
