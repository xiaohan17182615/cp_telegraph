import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { artifactsFromThreadItem } from "../src/bridge/codex-app-runner.js";

test("artifactsFromThreadItem ignores imageView input previews", () => {
  assert.deepEqual(artifactsFromThreadItem({
    type: "imageView",
    path: path.resolve("uploads/inbound/original.jpg"),
  }), []);
});

test("artifactsFromThreadItem returns one generated image path", () => {
  const savedPath = path.resolve("wechat-codex-artifacts/result.png");
  const result = path.resolve("wechat-codex-artifacts/result-copy.png");

  assert.deepEqual(artifactsFromThreadItem({
    type: "imageGeneration",
    savedPath,
    result,
  }), [savedPath]);
});
