import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { aesEcbPaddedSize, buildCdnUploadUrl, encryptAesEcb, mimeFromFilename } from "./media.js";
import { MessageItemType, MessageState, MessageType, UploadMediaType, type WeixinMessageItem, type WeixinSendMessageRequest } from "./types.js";
import type { WeixinClient } from "./client.js";

export interface SendMediaFileOptions {
  client: WeixinClient;
  token: string;
  toUserId: string;
  filePath: string;
  contextToken?: string;
  cdnBaseUrl: string;
  uploadsDir: string;
  maxBytes: number;
  caption?: string;
}

interface UploadedFileInfo {
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

interface PreparedMedia {
  filePath: string;
  mimeType: string;
}

export async function sendMediaFile(options: SendMediaFileOptions): Promise<void> {
  const prepared = await prepareMediaFileForUpload(options.filePath, options.uploadsDir);
  const uploadType = mediaTypeFromMime(prepared.mimeType);
  try {
    await sendPreparedMedia(options, prepared, uploadType);
    return;
  } catch (error) {
    if (uploadType !== UploadMediaType.IMAGE) throw error;
    try {
      await sendPreparedMedia(options, prepared, UploadMediaType.FILE);
      return;
    } catch (fallbackError) {
      throw new Error(`image upload failed (${errorMessage(error)}); file fallback failed (${errorMessage(fallbackError)})`);
    }
  }
}

async function sendPreparedMedia(
  options: SendMediaFileOptions,
  prepared: PreparedMedia,
  uploadType: number,
): Promise<void> {
  const uploaded = await uploadToWeChatCdn({
    ...options,
    filePath: prepared.filePath,
    mediaType: uploadType,
  });
  const mediaItem = buildMediaItem(prepared.filePath, prepared.mimeType, uploaded, uploadType);
  const items: WeixinMessageItem[] = [
    ...(options.caption ? [{ type: MessageItemType.TEXT, text_item: { text: options.caption } }] : []),
    mediaItem,
  ];
  for (const item of items) {
    await options.client.sendMessage({
      token: options.token,
      timeoutMs: 30_000,
      body: buildSingleItemMessage(options.toUserId, item, options.contextToken),
    });
  }
}

export async function prepareMediaFileForUpload(filePath: string, uploadsDir: string): Promise<PreparedMedia> {
  const absolute = path.resolve(filePath);
  const mimeType = mimeFromFilename(absolute);
  if (mimeType === "image/svg+xml") {
    return renderWechatSafeImage(absolute, uploadsDir);
  }
  if (mimeType.startsWith("image/")) {
    const metadata = await sharp(absolute, { limitInputPixels: false }).metadata().catch(() => undefined);
    if (metadata?.hasAlpha) return renderWechatSafeImage(absolute, uploadsDir);
  }
  return { filePath: absolute, mimeType };
}

async function renderWechatSafeImage(filePath: string, uploadsDir: string): Promise<PreparedMedia> {
  const day = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(uploadsDir, "outbound", day);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${path.basename(filePath, path.extname(filePath))}.png`);
  const image = sharp(filePath, { limitInputPixels: false }).rotate().flatten({ background: "#ffffff" }).toColorspace("srgb");
  await image.png().toFile(outputPath);
  return { filePath: outputPath, mimeType: "image/png" };
}

async function uploadToWeChatCdn(params: SendMediaFileOptions & { mediaType: number }): Promise<UploadedFileInfo> {
  const plaintext = await fs.readFile(params.filePath);
  if (plaintext.length > params.maxBytes) {
    throw new Error(`outbound media exceeds max size: ${plaintext.length} > ${params.maxBytes}`);
  }
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(plaintext.length);
  const uploadUrl = await params.client.getUploadUrl({
    token: params.token,
    timeoutMs: 30_000,
    body: {
      filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: plaintext.length,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  });
  const uploadParam = uploadUrl.upload_param;
  const cdnUrl = uploadUrl.upload_full_url
    ?? (uploadParam ? buildCdnUploadUrl({ uploadParam, filekey, cdnBaseUrl: params.cdnBaseUrl }) : undefined);
  if (!cdnUrl) throw new Error("getuploadurl returned no upload URL");

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const response = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CDN upload failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param");
  return {
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskeyHex,
    fileSize: plaintext.length,
    fileSizeCiphertext: ciphertext.length,
  };
}

function buildMediaItem(filePath: string, mimeType: string, uploaded: UploadedFileInfo, uploadType: number): WeixinMessageItem {
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
    encrypt_type: 1,
  };
  if (uploadType === UploadMediaType.IMAGE && mimeType.startsWith("image/")) {
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media,
        mid_size: uploaded.fileSizeCiphertext,
      },
    };
  }
  if (uploadType === UploadMediaType.VIDEO && mimeType.startsWith("video/")) {
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media,
        video_size: uploaded.fileSizeCiphertext,
      },
    };
  }
  return {
    type: MessageItemType.FILE,
    file_item: {
      media,
      file_name: path.basename(filePath),
      len: String(uploaded.fileSize),
    },
  };
}

function buildSingleItemMessage(toUserId: string, item: WeixinMessageItem, contextToken?: string): WeixinSendMessageRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      context_token: contextToken,
      client_id: `wechat-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
    },
  };
}

function mediaTypeFromMime(mimeType: string): number {
  if (mimeType.startsWith("image/")) return UploadMediaType.IMAGE;
  if (mimeType.startsWith("video/")) return UploadMediaType.VIDEO;
  return UploadMediaType.FILE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
