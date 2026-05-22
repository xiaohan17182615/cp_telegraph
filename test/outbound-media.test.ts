import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { mediaTypeForUpload, prepareMediaFileForUpload, sendMediaFile } from "../src/weixin/outbound-media.js";
import { MessageItemType, UploadMediaType } from "../src/weixin/types.js";

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

test("sendMediaFile falls back to file item when image upload fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-outbound-"));
  const pngPath = path.join(tmp, "large.png");
  await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: "#224466",
    },
  }).png().toFile(pngPath);

  const uploadTypes: number[] = [];
  const sentBodies: unknown[] = [];
  const client = {
    getUploadUrl: async ({ body }: { body: { media_type: number } }) => {
      uploadTypes.push(body.media_type);
      return { upload_full_url: `https://upload.example/${body.media_type}` };
    },
    sendMessage: async ({ body }: { body: unknown }) => {
      sentBodies.push(body);
      return {};
    },
  };
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    if (fetchCount === 1) throw new Error("fetch failed");
    return new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param" },
    });
  }) as typeof fetch;

  try {
    await sendMediaFile({
      client: client as never,
      token: "token",
      toUserId: "user-1",
      filePath: pngPath,
      cdnBaseUrl: "https://cdn.example.test",
      uploadsDir: tmp,
      maxBytes: 100 * 1024 * 1024,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(uploadTypes, [UploadMediaType.IMAGE, UploadMediaType.FILE]);
  assert.equal(sentBodies.length, 1);
  const sent = sentBodies[0] as { msg?: { item_list?: Array<{ type?: number; file_item?: { file_name?: string } }> } };
  assert.equal(sent.msg?.item_list?.[0]?.type, MessageItemType.FILE);
  assert.equal(sent.msg?.item_list?.[0]?.file_item?.file_name, "large.png");
});

test("mediaTypeForUpload sends very large images as files", () => {
  assert.equal(mediaTypeForUpload("image/png", 19 * 1024 * 1024), UploadMediaType.IMAGE);
  assert.equal(mediaTypeForUpload("image/png", 21 * 1024 * 1024), UploadMediaType.FILE);
});

test("sendMediaFile creates a JPEG delivery image after image and file upload fail", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-outbound-"));
  const pngPath = path.join(tmp, "large.png");
  await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: "#335577",
    },
  }).png().toFile(pngPath);

  const uploadTypes: number[] = [];
  const sentBodies: unknown[] = [];
  const client = {
    getUploadUrl: async ({ body }: { body: { media_type: number } }) => {
      uploadTypes.push(body.media_type);
      return { upload_full_url: `https://upload.example/${uploadTypes.length}` };
    },
    sendMessage: async ({ body }: { body: unknown }) => {
      sentBodies.push(body);
      return {};
    },
  };
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    if (fetchCount <= 2) throw new Error("fetch failed");
    return new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param" },
    });
  }) as typeof fetch;

  try {
    await sendMediaFile({
      client: client as never,
      token: "token",
      toUserId: "user-1",
      filePath: pngPath,
      cdnBaseUrl: "https://cdn.example.test",
      uploadsDir: tmp,
      maxBytes: 100 * 1024 * 1024,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(uploadTypes, [UploadMediaType.IMAGE, UploadMediaType.FILE, UploadMediaType.IMAGE]);
  const sent = sentBodies[0] as { msg?: { item_list?: Array<{ type?: number; image_item?: unknown }> } };
  assert.equal(sent.msg?.item_list?.[0]?.type, MessageItemType.IMAGE);
  assert.ok(sent.msg?.item_list?.[0]?.image_item);
});
