import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prepareMediaFileForUpload } from "../src/weixin/outbound-media.js";

test("prepareMediaFileForUpload renders SVG as opaque PNG", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-outbound-"));
  const svgPath = path.join(tmp, "poster.svg");
  fs.writeFileSync(svgPath, [
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">',
    '<rect width="240" height="320" fill="none"/>',
    '<circle cx="120" cy="160" r="90" fill="rgba(20,90,160,.55)"/>',
    '<text x="120" y="172" text-anchor="middle" font-size="36" fill="#111">南京</text>',
    "</svg>",
  ].join(""));

  const prepared = await prepareMediaFileForUpload(svgPath, path.join(tmp, "uploads"));
  const metadata = await sharp(prepared.filePath).metadata();

  assert.equal(prepared.mimeType, "image/png");
  assert.equal(path.extname(prepared.filePath), ".png");
  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 320);
  assert.equal(metadata.hasAlpha, false);
});

test("prepareMediaFileForUpload keeps opaque PNG bytes unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-outbound-"));
  const pngPath = path.join(tmp, "poster.png");
  await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: "#336699",
    },
  }).png().toFile(pngPath);
  const before = fs.readFileSync(pngPath);

  const prepared = await prepareMediaFileForUpload(pngPath, path.join(tmp, "uploads"));

  assert.equal(prepared.filePath, pngPath);
  assert.equal(prepared.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(prepared.filePath), before);
});

test("prepareMediaFileForUpload keeps JPEG bytes unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-outbound-"));
  const jpgPath = path.join(tmp, "poster.jpg");
  await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: "#663399",
    },
  }).jpeg({ quality: 91 }).toFile(jpgPath);
  const before = fs.readFileSync(jpgPath);

  const prepared = await prepareMediaFileForUpload(jpgPath, path.join(tmp, "uploads"));

  assert.equal(prepared.filePath, jpgPath);
  assert.equal(prepared.mimeType, "image/jpeg");
  assert.deepEqual(fs.readFileSync(prepared.filePath), before);
});
