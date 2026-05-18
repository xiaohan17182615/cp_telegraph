import type { AppConfig } from "../config.js";
import { splitForWeChat } from "../util/text.js";
import { WeixinAccountStore, type StoredWeixinAccount } from "./account-store.js";
import { WeixinClient } from "./client.js";
import { downloadMessageItemMedia } from "./media.js";
import { MessageItemType, MessageState, MessageType, TypingStatus, type WeixinMessage, type WeixinMessageItem, type WeixinSendMessageRequest } from "./types.js";

export interface InboundAttachment {
  id: string;
  kind: "image" | "voice" | "file" | "video";
  name?: string;
  sizeBytes?: number;
  localPath?: string;
  mimeType?: string;
  downloadError?: string;
  raw: unknown;
}

export interface InboundMessage {
  routeKey: string;
  accountId: string;
  conversationId: string;
  conversationKind: "direct" | "group";
  senderId: string;
  messageId: string;
  text: string;
  attachments: InboundAttachment[];
  contextToken?: string;
  timestamp: string;
  raw: WeixinMessage;
}

export class WeixinAdapter {
  private readonly store: WeixinAccountStore;
  private running = false;
  private outboundQueue: Promise<void> = Promise.resolve();
  private lastSentAt = 0;
  private account?: StoredWeixinAccount;
  private client?: WeixinClient;
  private readonly typingTicketCache = new Map<string, string>();

  constructor(private readonly config: AppConfig) {
    this.store = new WeixinAccountStore(config.accountsDir);
  }

  get accountStore(): WeixinAccountStore {
    return this.store;
  }

  status(): { account?: string; running: boolean; cursor?: string } {
    const account = this.account ?? this.store.getDefaultAccount();
    return { account: account?.accountId, running: this.running, cursor: account?.syncCursor };
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const account = this.store.getDefaultAccount();
    if (!account) throw new Error("No WeChat account. Run `wechat-codex login` first.");
    this.account = account;
    this.client = new WeixinClient({ baseUrl: account.baseUrl || this.config.baseUrl, botAgent: this.config.botAgent });
    this.running = true;
    void this.client.notifyStart({ token: account.token, timeoutMs: 10_000 }).catch(() => undefined);
    let syncCursor = account.syncCursor ?? "";
    let longPollTimeoutMs = this.config.longPollTimeoutMs;
    while (this.running) {
      try {
        const response = await this.client.getUpdates({
          token: account.token,
          syncCursor,
          timeoutMs: longPollTimeoutMs,
        });
        if (Number.isFinite(response.longpolling_timeout_ms) && Number(response.longpolling_timeout_ms) > 0) {
          longPollTimeoutMs = Number(response.longpolling_timeout_ms);
        }
        const nextCursor = response.get_updates_buf ?? response.sync_buf ?? syncCursor;
        if (nextCursor !== syncCursor) {
          syncCursor = nextCursor;
          this.store.saveSyncCursor(account.accountId, syncCursor);
        }
        for (const raw of response.msgs ?? []) {
          const normalized = normalizeMessage(account, raw);
          if (!normalized) continue;
          if (this.config.downloadMedia) await this.downloadAttachments(normalized);
          await onMessage(normalized);
        }
      } catch (error) {
        if (!this.running) return;
        console.error(`[weixin] poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(2000);
      }
    }
  }

  stop(): void {
    this.running = false;
    const account = this.account;
    const client = this.client;
    if (account && client) void client.notifyStop({ token: account.token, timeoutMs: 5000 }).catch(() => undefined);
  }

  async sendText(conversationId: string, content: string, contextToken?: string): Promise<void> {
    const account = this.account ?? this.store.getDefaultAccount();
    if (!account) throw new Error("No WeChat account. Run login first.");
    const client = this.client ?? new WeixinClient({ baseUrl: account.baseUrl || this.config.baseUrl, botAgent: this.config.botAgent });
    for (const chunk of splitForWeChat(content, this.config.maxMessageBytes)) {
      await this.enqueue(async () => {
        const body = buildTextMessage(conversationId, chunk, contextToken);
        await retry(async () => client.sendMessage({ token: account.token, body, timeoutMs: 30_000 }), 3);
      });
    }
  }

  async sendTyping(ilinkUserId: string, contextToken: string | undefined, status: number = TypingStatus.TYPING): Promise<void> {
    if (!this.config.typingEnabled) return;
    const account = this.account ?? this.store.getDefaultAccount();
    if (!account) return;
    const client = this.client ?? new WeixinClient({ baseUrl: account.baseUrl || this.config.baseUrl, botAgent: this.config.botAgent });
    const cacheKey = `${account.accountId}:${ilinkUserId}:${contextToken ?? ""}`;
    let typingTicket = this.typingTicketCache.get(cacheKey);
    if (!typingTicket) {
      const config = await client.getConfig({
        token: account.token,
        ilinkUserId,
        contextToken,
        timeoutMs: 10_000,
      });
      typingTicket = config.typing_ticket;
      if (!typingTicket) return;
      this.typingTicketCache.set(cacheKey, typingTicket);
    }
    await client.sendTyping({
      token: account.token,
      ilinkUserId,
      typingTicket,
      status,
      timeoutMs: 10_000,
    });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const previous = this.outboundQueue;
    let release!: () => void;
    this.outboundQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      const wait = Math.max(0, this.lastSentAt + this.config.minSendIntervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      await task();
      this.lastSentAt = Date.now();
    } finally {
      release();
    }
  }

  private async downloadAttachments(message: InboundMessage): Promise<void> {
    for (const attachment of message.attachments) {
      try {
        const downloaded = await downloadMessageItemMedia(attachment.raw as WeixinMessageItem, {
          cdnBaseUrl: this.config.cdnBaseUrl,
          uploadsDir: this.config.uploadsDir,
          maxBytes: this.config.mediaMaxBytes,
          messageId: message.messageId,
        });
        if (!downloaded) continue;
        attachment.localPath = downloaded.path;
        attachment.mimeType = downloaded.mimeType;
        attachment.sizeBytes = downloaded.sizeBytes;
      } catch (error) {
        attachment.downloadError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

export function normalizeMessage(account: StoredWeixinAccount, raw: WeixinMessage): InboundMessage | null {
  if (raw.message_type === MessageType.BOT) return null;
  const senderId = raw.from_user_id?.trim();
  if (!senderId || senderId === account.accountId) return null;
  const roomId = raw.group_id || raw.room_id || raw.chat_room_id;
  const conversationKind = roomId ? "group" : "direct";
  const conversationId = roomId || senderId;
  const text = extractText(raw).trim();
  const attachments = extractAttachments(raw);
  if (!text && attachments.length === 0) return null;
  return {
    routeKey: `weixin:${account.accountId}:${conversationKind}:${conversationId}`,
    accountId: account.accountId,
    conversationId,
    conversationKind,
    senderId,
    messageId: String(raw.message_id ?? raw.client_id ?? raw.seq ?? Date.now()),
    text,
    attachments,
    contextToken: raw.context_token,
    timestamp: new Date(raw.create_time_ms ?? Date.now()).toISOString(),
    raw,
  };
}

function buildTextMessage(toUserId: string, text: string, contextToken?: string): WeixinSendMessageRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      context_token: contextToken,
      client_id: `wechat-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    },
  };
}

function extractText(raw: WeixinMessage): string {
  for (const item of raw.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) return item.text_item.text;
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) return item.voice_item.text;
  }
  return "";
}

function extractAttachments(raw: WeixinMessage): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  for (const [index, item] of (raw.item_list ?? []).entries()) {
    const id = String(item.msg_id ?? `${raw.message_id ?? "msg"}-${index}`);
    if (item.type === MessageItemType.IMAGE && item.image_item) {
      out.push({ id, kind: "image", sizeBytes: item.image_item.hd_size ?? item.image_item.mid_size ?? item.image_item.thumb_size, raw: item });
    } else if (item.type === MessageItemType.VOICE && item.voice_item) {
      out.push({ id, kind: "voice", raw: item });
    } else if (item.type === MessageItemType.FILE && item.file_item) {
      out.push({ id, kind: "file", name: item.file_item.file_name, sizeBytes: Number.parseInt(item.file_item.len ?? "", 10) || undefined, raw: item });
    } else if (item.type === MessageItemType.VIDEO && item.video_item) {
      out.push({ id, kind: "video", sizeBytes: item.video_item.video_size, raw: item });
    }
  }
  return out;
}

async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
