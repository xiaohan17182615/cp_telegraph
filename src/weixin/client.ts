import crypto from "node:crypto";
import type {
  GetUpdatesResponse,
  QrStartResponse,
  QrStatusResponse,
  SendMessageResponse,
  WeixinSendMessageRequest,
} from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WeixinClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  channelVersion?: string;
  botAgent?: string;
}

interface ApiResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export class WeixinClient {
  private readonly fetchImpl: FetchLike;
  private readonly channelVersion: string;
  private readonly botAgent: string;

  constructor(private readonly options: WeixinClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.channelVersion = options.channelVersion ?? "2.4.3";
    this.botAgent = options.botAgent ?? "WechatCodexBridge/0.1.0";
  }

  async getBotQr(params: { botType: string; localTokenList?: string[]; timeoutMs?: number }): Promise<QrStartResponse> {
    return this.postJson<QrStartResponse>({
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType)}`,
      body: { local_token_list: params.localTokenList ?? [] },
      timeoutMs: params.timeoutMs,
      authorized: false,
    });
  }

  async getQrStatus(params: {
    qrcode: string;
    baseUrl?: string;
    verifyCode?: string;
    timeoutMs?: number;
  }): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    return this.getJson<QrStatusResponse>({
      endpoint,
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      authorized: false,
    });
  }

  async getUpdates(params: { token: string; syncCursor?: string; timeoutMs?: number }): Promise<GetUpdatesResponse> {
    const response = await this.postJson<GetUpdatesResponse>({
      endpoint: "ilink/bot/getupdates",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        get_updates_buf: params.syncCursor ?? "",
        base_info: this.baseInfo(),
      },
    });
    assertSuccess(response, "getupdates");
    return response;
  }

  async sendMessage(params: { token: string; body: WeixinSendMessageRequest; timeoutMs?: number }): Promise<SendMessageResponse> {
    const response = await this.postJson<SendMessageResponse>({
      endpoint: "ilink/bot/sendmessage",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: {
        ...params.body,
        base_info: this.baseInfo(),
      },
    });
    assertSuccess(response, "sendmessage");
    return response;
  }

  async notifyStart(params: { token: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystart",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: { base_info: this.baseInfo() },
    });
  }

  async notifyStop(params: { token: string; timeoutMs?: number }): Promise<void> {
    await this.postJson<unknown>({
      endpoint: "ilink/bot/msg/notifystop",
      token: params.token,
      timeoutMs: params.timeoutMs,
      body: { base_info: this.baseInfo() },
    });
  }

  private async getJson<T>(params: {
    endpoint: string;
    baseUrl?: string;
    timeoutMs?: number;
    authorized?: boolean;
  }): Promise<T> {
    const response = await this.fetchWithTimeout(this.url(params.endpoint, params.baseUrl), {
      method: "GET",
      headers: this.headers({ authorized: params.authorized ?? true }),
    }, params.timeoutMs);
    return parseJson<T>(response, params.endpoint);
  }

  private async postJson<T>(params: {
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs?: number;
    authorized?: boolean;
  }): Promise<T> {
    const response = await this.fetchWithTimeout(this.url(params.endpoint), {
      method: "POST",
      headers: this.headers({ token: params.token, authorized: params.authorized ?? true, json: true }),
      body: JSON.stringify(params.body),
    }, params.timeoutMs);
    return parseJson<T>(response, params.endpoint);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private url(endpoint: string, baseUrl = this.options.baseUrl): string {
    return new URL(endpoint.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
  }

  private baseInfo(): Record<string, string> {
    return {
      channel_version: this.channelVersion,
      bot_agent: this.botAgent,
    };
  }

  private headers(params: { token?: string; authorized: boolean; json?: boolean }): Record<string, string> {
    return {
      ...(params.json ? { "Content-Type": "application/json" } : {}),
      "AuthorizationType": "ilink_bot_token",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(clientVersion(this.channelVersion)),
      "X-WECHAT-UIN": randomUin(),
      ...(params.authorized && params.token ? { Authorization: `Bearer ${params.token}` } : {}),
    };
  }
}

async function parseJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} http ${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function assertSuccess(response: ApiResponse | undefined, label: string): void {
  const ret = Number(response?.ret ?? 0);
  const errcode = Number(response?.errcode ?? 0);
  if (ret !== 0 || errcode !== 0) {
    throw new Error(`${label} failed: ret=${ret} errcode=${errcode} ${response?.errmsg ?? ""}`.trim());
  }
}

function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}
