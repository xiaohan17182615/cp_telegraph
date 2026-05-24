import crypto from "node:crypto";
import { createReadStream } from "node:fs";
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
  publicArtifact?: PublicArtifactOptions;
}

export interface PublicArtifactOptions {
  dir: string;
  baseUrl: string;
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

const LARGE_IMAGE_FILE_FALLBACK_BYTES = 20 * 1024 * 1024;
const CDN_UPLOAD_TIMEOUT_MS = 90_000;
const CDN_UPLOAD_ATTEMPTS = 3;
const CDN_UPLOAD_RETRY_DELAY_MS = 250;

class CdnUploadHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CdnUploadHttpError";
  }
}

export async function sendMediaFile(options: SendMediaFileOptions): Promise<void> {
  const prepared = await prepareMediaFileForUpload(options.filePath, options.uploadsDir);
  const stat = await fs.stat(prepared.filePath);
  const uploadType = mediaTypeForUpload(prepared.mimeType, stat.size);
  const errors: string[] = [];
  try {
    await sendPreparedMedia(options, prepared, uploadType);
    return;
  } catch (error) {
    errors.push(`${uploadTypeName(uploadType)} upload failed (${errorMessage(error)})`);
    if (!prepared.mimeType.startsWith("image/")) {
      if (options.publicArtifact) {
        try {
          await sendPublicLinkedFile(options, prepared);
          return;
        } catch (publicError) {
          errors.push(`public full_url fallback failed (${errorMessage(publicError)})`);
        }
      }
      throw new Error(errors.join("; "));
    }
    if (uploadType === UploadMediaType.IMAGE) {
      try {
        await sendPreparedMedia(options, prepared, UploadMediaType.FILE);
        return;
      } catch (fallbackError) {
        errors.push(`file fallback failed (${errorMessage(fallbackError)})`);
      }
    }
  }
  if (options.publicArtifact) {
    try {
      await sendPublicLinkedFile(options, {
        filePath: path.resolve(options.filePath),
        mimeType: mimeFromFilename(options.filePath),
      });
      return;
    } catch (publicError) {
      errors.push(`public full_url fallback failed (${errorMessage(publicError)})`);
    }
  }
  const delivery = await createWechatDeliveryImage(prepared, options.uploadsDir);
  if (delivery) {
    const deliveryStat = await fs.stat(delivery.filePath);
    const deliveryUploadType = mediaTypeForUpload(delivery.mimeType, deliveryStat.size);
    try {
      await sendPreparedMedia(options, delivery, deliveryUploadType);
      return;
    } catch (deliveryError) {
      errors.push(`delivery image fallback failed (${errorMessage(deliveryError)})`);
    }
  }
  throw new Error(errors.join("; "));
}

async function sendPublicLinkedFile(options: SendMediaFileOptions, prepared: PreparedMedia): Promise<void> {
  if (!options.publicArtifact) throw new Error("public artifact fallback is not configured");
  const published = await publishPublicArtifact(prepared.filePath, options.publicArtifact);
  const stat = await fs.stat(prepared.filePath);
  const mediaItem = buildPublicFileItem(prepared.filePath, published.url, stat.size);
  const items: WeixinMessageItem[] = [
    ...(options.caption ? [{ type: MessageItemType.TEXT, text_item: { text: options.caption } }] : []),
    { type: MessageItemType.TEXT, text_item: { text: buildPublicArtifactNotice(prepared.filePath, published.url, stat.size) } },
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

async function publishPublicArtifact(filePath: string, options: PublicArtifactOptions): Promise<{ filePath: string; url: string }> {
  const absolute = path.resolve(filePath);
  const day = new Date().toISOString().slice(0, 10);
  const digest = await sha256File(absolute);
  const fileName = `${digest.slice(0, 16)}-${safePublicFileName(path.basename(absolute))}`;
  const outputDir = path.join(options.dir, day);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  await fs.copyFile(absolute, outputPath);
  await fs.chmod(outputPath, 0o644).catch(() => undefined);
  return {
    filePath: outputPath,
    url: buildPublicArtifactUrl(options.baseUrl, [day, fileName]),
  };
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
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

async function createWechatDeliveryImage(prepared: PreparedMedia, uploadsDir: string): Promise<PreparedMedia | undefined> {
  if (!prepared.mimeType.startsWith("image/")) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(uploadsDir, "outbound", day);
  await fs.mkdir(outputDir, { recursive: true });
  for (const quality of [94, 90, 86]) {
    const outputPath = path.join(
      outputDir,
      `${path.basename(prepared.filePath, path.extname(prepared.filePath))}-wechat-delivery-q${quality}.jpg`,
    );
    await sharp(prepared.filePath, { limitInputPixels: false })
      .rotate()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);
    const stat = await fs.stat(outputPath);
    if (stat.size <= LARGE_IMAGE_FILE_FALLBACK_BYTES || quality === 86) {
      return { filePath: outputPath, mimeType: "image/jpeg" };
    }
  }
  return undefined;
}

async function uploadToWeChatCdn(params: SendMediaFileOptions & { mediaType: number }): Promise<UploadedFileInfo> {
  const plaintext = await fs.readFile(params.filePath);
  if (plaintext.length > params.maxBytes) {
    throw new Error(`outbound media exceeds max size: ${plaintext.length} > ${params.maxBytes}`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await uploadToWeChatCdnOnce(params, plaintext);
    } catch (error) {
      lastError = error;
      if (isCdnClientError(error)) throw error;
      if (attempt < CDN_UPLOAD_ATTEMPTS) await delay(CDN_UPLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`CDN upload failed after ${CDN_UPLOAD_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function uploadToWeChatCdnOnce(
  params: SendMediaFileOptions & { mediaType: number },
  plaintext: Buffer,
): Promise<UploadedFileInfo> {
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
    signal: AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CdnUploadHttpError(response.status, `CDN upload failed: ${response.status} ${text.slice(0, 200)}`);
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function buildPublicFileItem(filePath: string, fullUrl: string, size: number): WeixinMessageItem {
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        full_url: fullUrl,
        encrypt_type: 0,
      },
      file_name: path.basename(filePath),
      len: String(size),
    },
  };
}

function buildPublicArtifactNotice(filePath: string, fullUrl: string, size: number): string {
  return [
    "iLink CDN 暂时无法接收原始文件，已改用原始文件链接发送：",
    `${path.basename(filePath)} (${formatBytes(size)})`,
    fullUrl,
  ].join("\n");
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
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

export function mediaTypeForUpload(mimeType: string, sizeBytes = 0): number {
  if (mimeType.startsWith("image/") && sizeBytes > LARGE_IMAGE_FILE_FALLBACK_BYTES) return UploadMediaType.FILE;
  return mediaTypeFromMime(mimeType);
}

function mediaTypeFromMime(mimeType: string): number {
  if (mimeType.startsWith("image/")) return UploadMediaType.IMAGE;
  if (mimeType.startsWith("video/")) return UploadMediaType.VIDEO;
  return UploadMediaType.FILE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function isCdnClientError(error: unknown): boolean {
  return error instanceof CdnUploadHttpError && error.status >= 400 && error.status < 500;
}

function uploadTypeName(uploadType: number): string {
  if (uploadType === UploadMediaType.IMAGE) return "image";
  if (uploadType === UploadMediaType.VIDEO) return "video";
  if (uploadType === UploadMediaType.FILE) return "file";
  return `media_type_${uploadType}`;
}

function safePublicFileName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    || "artifact.bin";
}

function buildPublicArtifactUrl(baseUrl: string, segments: string[]): string {
  return `${baseUrl.replace(/\/+$/g, "")}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
