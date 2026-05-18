import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MessageItemType, type CdnMedia, type WeixinMessageItem } from "./types.js";

export interface DownloadedMedia {
  path: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MediaDownloadOptions {
  cdnBaseUrl: string;
  uploadsDir: string;
  maxBytes: number;
  messageId: string;
}

export async function downloadMessageItemMedia(
  item: WeixinMessageItem,
  options: MediaDownloadOptions,
): Promise<DownloadedMedia | undefined> {
  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    const media = item.image_item.media;
    const key = item.image_item.aeskey
      ? Buffer.from(item.image_item.aeskey, "hex")
      : parseAesKey(media.aes_key);
    const bytes = key
      ? decryptAesEcb(await fetchMediaBytes(media, options), key)
      : await fetchMediaBytes(media, options);
    return saveInboundMedia(bytes, options, safeFileName(`${item.msg_id ?? "image"}.jpg`), "image/jpeg");
  }

  if (item.type === MessageItemType.FILE && item.file_item?.media) {
    const media = item.file_item.media;
    const key = parseAesKey(media.aes_key);
    if (!key) return undefined;
    const bytes = decryptAesEcb(await fetchMediaBytes(media, options), key);
    const filename = safeFileName(item.file_item.file_name || `${item.msg_id ?? "file"}.bin`);
    return saveInboundMedia(bytes, options, filename, mimeFromFilename(filename));
  }

  if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
    const media = item.video_item.media;
    const key = parseAesKey(media.aes_key);
    if (!key) return undefined;
    const bytes = decryptAesEcb(await fetchMediaBytes(media, options), key);
    return saveInboundMedia(bytes, options, safeFileName(`${item.msg_id ?? "video"}.mp4`), "video/mp4");
  }

  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    const media = item.voice_item.media;
    const key = parseAesKey(media.aes_key);
    if (!key) return undefined;
    const bytes = decryptAesEcb(await fetchMediaBytes(media, options), key);
    return saveInboundMedia(bytes, options, safeFileName(`${item.msg_id ?? "voice"}.silk`), "audio/silk");
  }

  return undefined;
}

async function fetchMediaBytes(media: CdnMedia, options: MediaDownloadOptions): Promise<Buffer> {
  const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param, options.cdnBaseUrl);
  if (!url) throw new Error("media is missing full_url and encrypt_query_param");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > options.maxBytes) {
    throw new Error(`media exceeds max size: ${bytes.length} > ${options.maxBytes}`);
  }
  return bytes;
}

function buildCdnDownloadUrl(encryptedQueryParam: string | undefined, cdnBaseUrl: string): string | undefined {
  if (!encryptedQueryParam) return undefined;
  return `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(params: { uploadParam: string; filekey: string; cdnBaseUrl: string }): string {
  return `${params.cdnBaseUrl.replace(/\/+$/, "")}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

export function parseAesKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  return undefined;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function aesEcbPaddedSize(size: number): number {
  const remainder = size % 16;
  return size + (remainder === 0 ? 16 : 16 - remainder);
}

async function saveInboundMedia(
  bytes: Buffer,
  options: MediaDownloadOptions,
  filename: string,
  mimeType: string,
): Promise<DownloadedMedia> {
  if (bytes.length > options.maxBytes) {
    throw new Error(`media exceeds max size after decrypt: ${bytes.length} > ${options.maxBytes}`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(options.uploadsDir, "inbound", day);
  await fs.mkdir(dir, { recursive: true });
  const prefix = safeFileName(options.messageId).slice(0, 80);
  const filePath = path.join(dir, `${prefix}-${filename}`);
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  return { path: filePath, mimeType, sizeBytes: bytes.length };
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, " ").slice(0, 160) || "media.bin";
}

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const table: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".silk": "audio/silk",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
  };
  return table[ext] ?? "application/octet-stream";
}
