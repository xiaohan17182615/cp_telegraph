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

test("extractArtifactPaths finds generated office documents", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-artifact-"));
  const file = path.join(tmp, "math_answers_summary.docx");
  fs.writeFileSync(file, "fake docx");
  const text = `已整理完成\n文件：${file}`;

  assert.deepEqual(extractArtifactPaths(text, tmp), [file]);
  assert.equal(stripArtifactDirectives(text), "已整理完成");
});

test("extractArtifactPaths accepts loose file references", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-artifact-"));
  const file = path.join(tmp, "1.docx");
  fs.writeFileSync(file, "fake docx");

  assert.deepEqual(extractArtifactPaths("已生成：`1.docx`", tmp), [file]);
  assert.deepEqual(extractArtifactPaths("文件在这里：`1.docx`", tmp), [file]);
  assert.deepEqual(extractArtifactPaths("`1.docx`", tmp), [file]);
  assert.equal(stripArtifactDirectives("文件在这里：`1.docx`\n内容：wycdsb"), "内容：wycdsb");
});

test("artifact helpers detect image requests and placeholder replies", () => {
  assert.equal(isImageArtifactRequest("生成北戴河旅游海报"), true);
  assert.equal(isImageArtifactRequest("查一下天气"), false);
  assert.equal(isPlaceholderArtifactReply("我会用 imagegen 技能生成一张位图旅游海报。"), true);
});
