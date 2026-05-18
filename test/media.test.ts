import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadMessageItemMedia } from "../src/weixin/media.js";
import { MessageItemType } from "../src/weixin/types.js";

test("downloadMessageItemMedia decrypts and saves image media", async () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("fake image bytes");
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-media-"));
  const fullUrl = `data:application/octet-stream;base64,${encrypted.toString("base64")}`;
  const saved = await downloadMessageItemMedia({
    type: MessageItemType.IMAGE,
    msg_id: "img1",
    image_item: {
      aeskey: key.toString("hex"),
      media: { full_url: fullUrl },
    },
  }, {
    cdnBaseUrl: "https://cdn.example.test",
    uploadsDir: tmp,
    maxBytes: 1024,
    messageId: "m1",
  });
  assert.ok(saved?.path);
  assert.deepEqual(fs.readFileSync(saved.path), plaintext);
  assert.equal(saved.mimeType, "image/jpeg");
});
