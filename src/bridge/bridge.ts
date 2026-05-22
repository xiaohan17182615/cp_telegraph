import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { JsonStateStore, type RouteState } from "../state.js";
import { sanitizeError } from "../util/text.js";
import { WeixinAdapter, type InboundMessage } from "../weixin/adapter.js";
import { TypingStatus } from "../weixin/types.js";
import { parseCommand, helpText } from "./commands.js";
import { CodexRunner } from "./codex-runner.js";
import { CodexAppRunner } from "./codex-app-runner.js";
import { PairingManager, parsePairCommand } from "./pairing.js";
import { createFallbackPoster, posterReadyText } from "./poster.js";
import { extractArtifactPaths, isImageArtifactRequest, isPlaceholderArtifactReply, stripArtifactDirectives } from "./artifacts.js";

interface PendingInboundMerge {
  message: InboundMessage;
  timer: ReturnType<typeof setTimeout>;
}

export class WechatCodexBridge {
  private readonly state: JsonStateStore;
  private readonly pairing = new PairingManager();
  private readonly codex: CodexRunner;
  private readonly nativeCodex: CodexAppRunner;
  private readonly pendingInboundMerges = new Map<string, PendingInboundMerge>();

  constructor(
    private readonly config: AppConfig,
    private readonly weixin: WeixinAdapter,
  ) {
    this.state = new JsonStateStore(path.join(config.stateDir, "bridge-state.json"));
    this.codex = new CodexRunner(config);
    this.nativeCodex = new CodexAppRunner(config);
  }

  async start(): Promise<void> {
    await this.weixin.start((message) => this.handleMessage(message));
  }

  stop(): void {
    for (const pending of this.pendingInboundMerges.values()) clearTimeout(pending.timer);
    this.pendingInboundMerges.clear();
    for (const route of this.state.listRoutes()) this.nativeCodex.stop(route.routeKey);
    this.weixin.stop();
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    if (isImmediateMessage(message)) {
      this.cancelPendingInboundMerge(message.routeKey);
      await this.processMessage(message);
      return;
    }

    const pending = this.pendingInboundMerges.get(message.routeKey);
    if (pending) {
      pending.message = mergeInboundMessages(pending.message, message);
      if (shouldDelayInboundMessage(pending.message, this.config.inboundMergeWindowMs)) {
        this.reschedulePendingInboundMerge(message.routeKey, pending);
        return;
      }
      await this.flushPendingInboundMerge(message.routeKey);
      return;
    }

    if (shouldDelayInboundMessage(message, this.config.inboundMergeWindowMs)) {
      this.schedulePendingInboundMerge(message);
      return;
    }

    await this.processMessage(message);
  }

  private async processMessage(message: InboundMessage): Promise<void> {
    const route = this.state.getRoute(message.routeKey);
    if (message.contextToken) this.upsertRoute(message.routeKey, { contextToken: message.contextToken });
    const pairCode = parsePairCommand(message.text);
    if (pairCode) {
      await this.handlePair(message, pairCode);
      return;
    }

    if (this.config.pairingRequired && !route?.trusted) {
      if (message.conversationKind === "group" && !this.groupTriggered(message.text)) return;
      await this.challenge(message);
      return;
    }

    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command.name, command.args);
      return;
    }

    const prompt = this.promptForCodex(message);
    if (prompt === null) return;
    await this.runCodex(message, prompt);
  }

  private schedulePendingInboundMerge(message: InboundMessage): void {
    const pending: PendingInboundMerge = {
      message,
      timer: this.createInboundMergeTimer(message.routeKey),
    };
    this.pendingInboundMerges.set(message.routeKey, pending);
  }

  private reschedulePendingInboundMerge(routeKey: string, pending: PendingInboundMerge): void {
    clearTimeout(pending.timer);
    pending.timer = this.createInboundMergeTimer(routeKey);
  }

  private createInboundMergeTimer(routeKey: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.flushPendingInboundMerge(routeKey).catch((error) => {
        console.error(`[bridge:${routeKey}] pending inbound flush failed: ${sanitizeError(error)}`);
      });
    }, this.config.inboundMergeWindowMs);
    timer.unref?.();
    return timer;
  }

  private cancelPendingInboundMerge(routeKey: string): void {
    const pending = this.pendingInboundMerges.get(routeKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInboundMerges.delete(routeKey);
  }

  private async flushPendingInboundMerge(routeKey: string): Promise<void> {
    const pending = this.pendingInboundMerges.get(routeKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInboundMerges.delete(routeKey);
    await this.processMessage(pending.message);
  }

  private async handlePair(message: InboundMessage, code: string): Promise<void> {
    const result = this.pairing.verify(message.routeKey, code);
    if (result.ok) {
      this.state.trustRoute(message.routeKey);
      await this.reply(message, "配对成功。这个微信聊天现在可以使用 Codex。");
      return;
    }
    await this.reply(message, `配对失败：${result.reason}。请查看运行 wechat-codex 的终端，使用最新配对码。`);
  }

  private async challenge(message: InboundMessage): Promise<void> {
    const challenge = this.pairing.getOrCreate(message.routeKey);
    console.warn([
      "Pairing required",
      `route: ${message.routeKey}`,
      `sender: ${message.senderId}`,
      `code: ${challenge.code}`,
      `expires: ${new Date(challenge.expiresAt).toISOString()}`,
    ].join("\n"));
    await this.reply(message, "这个微信聊天还没有配对。请查看运行 wechat-codex 的终端，然后在这里发送 `/pair <code>`。");
  }

  private async handleCommand(message: InboundMessage, name: string, args: string[]): Promise<void> {
    if (name === "help") {
      await this.reply(message, helpText());
      return;
    }
    if (name === "status") {
      await this.reply(message, this.statusText(message));
      return;
    }
    if (name === "routes") {
      await this.reply(message, this.routesText());
      return;
    }
    if (name === "new") {
      const cwd = args.length > 0 ? path.resolve(args.join(" ")) : undefined;
      this.upsertRoute(message.routeKey, { codexThreadId: undefined, cwd });
      await this.reply(message, `已为当前聊天开启新的 Codex 对话。${cwd ? `\n工作目录：${cwd}` : ""}`);
      return;
    }
    if (name === "cwd") {
      if (args.length === 0) {
        await this.reply(message, `当前工作目录：${this.routeFor(message).cwd ?? this.config.cwd}`);
        return;
      }
      const cwd = path.resolve(args.join(" "));
      this.upsertRoute(message.routeKey, { cwd });
      await this.reply(message, `已设置工作目录：\n${cwd}`);
      return;
    }
    if (name === "retry") {
      const lastPrompt = this.routeFor(message).lastPrompt;
      if (!lastPrompt) {
        await this.reply(message, "当前聊天还没有可重试的上一条任务。");
        return;
      }
      await this.runCodex(message, lastPrompt);
      return;
    }
    if (name === "stop") {
      const stopped = this.codex.stop(message.routeKey) || this.nativeCodex.stop(message.routeKey);
      await this.reply(message, stopped ? "已向 Codex 发送停止信号。" : "当前聊天没有正在运行的 Codex 任务。");
      return;
    }
    await this.reply(message, `未知命令：/${name}\n发送 /help 查看可用命令。`);
  }

  private async runCodex(message: InboundMessage, prompt: string): Promise<void> {
    if (this.codex.isBusy(message.routeKey) || this.nativeCodex.isBusy(message.routeKey)) {
      await this.reply(message, "Codex 还在处理当前聊天的上一条任务。可以发送 /stop 中断，或稍等结果。");
      return;
    }
    const route = this.routeFor(message);
    const cwd = route.cwd ?? this.config.cwd;
    this.upsertRoute(message.routeKey, { lastPrompt: prompt, cwd });
    if (this.config.workingNotice) await this.reply(message, "Codex 正在处理...");
    this.setTyping(message, TypingStatus.TYPING);
    try {
      const attachmentNote = message.attachments.length > 0
        ? `\n\nIncoming WeChat attachments:\n${message.attachments.map(formatAttachmentForPrompt).join("\n")}`
        : "";
      const result = await this.runCodexBackend(message.routeKey, prompt, attachmentNote, cwd, route.codexThreadId);
      this.upsertRoute(message.routeKey, { codexThreadId: result.threadId, cwd });
      await this.replyWithArtifacts(message, prompt, cwd, result.text, result.artifacts);
    } catch (error) {
      await this.reply(message, formatCodexFailure(error));
    } finally {
      this.setTyping(message, TypingStatus.CANCEL);
    }
  }

  private statusText(message: InboundMessage): string {
    const route = this.routeFor(message);
    const wx = this.weixin.status();
    return [
      "桥接状态",
      `微信账号：${wx.account ?? "未登录"}`,
      `聊天路由：${message.routeKey}`,
      `已配对：${route.trusted ? "是" : "否"}`,
      `处理中：${this.codex.isBusy(message.routeKey) || this.nativeCodex.isBusy(message.routeKey) ? "是" : "否"}`,
      `运行器：${this.config.codexRunner}`,
      `工作目录：${route.cwd ?? this.config.cwd}`,
      `Codex 对话：${route.codexThreadId ?? "新对话"}`,
      `上下文 token：${route.contextToken ? "已缓存" : "无"}`,
      `工作提示：${this.config.workingNotice ? "开" : "关"}`,
      `入站合并窗口：${this.config.inboundMergeWindowMs}ms`,
    ].join("\n");
  }

  private routesText(): string {
    const routes = this.state.listRoutes().slice(0, 20);
    if (routes.length === 0) return "还没有记录任何聊天路由。";
    return routes.map((route, index) => [
      `${index + 1}. ${route.routeKey}`,
      `   已配对=${route.trusted ? "是" : "否"} 对话=${route.codexThreadId ?? "新对话"}`,
      `   更新时间=${route.updatedAt}`,
    ].join("\n")).join("\n");
  }

  private routeFor(message: InboundMessage): RouteState {
    return this.state.getRoute(message.routeKey) ?? {
      routeKey: message.routeKey,
      trusted: !this.config.pairingRequired,
      updatedAt: new Date().toISOString(),
    };
  }

  private promptForCodex(message: InboundMessage): string | null {
    if (message.conversationKind !== "group") return message.text;
    const trigger = this.config.groupTrigger;
    if (!trigger) return message.text;
    const trimmed = message.text.trim();
    if (!trimmed.toLowerCase().startsWith(trigger.toLowerCase())) return null;
    return trimmed.slice(trigger.length).replace(/^[\s:：,，]+/, "").trim() || "/help";
  }

  private groupTriggered(text: string): boolean {
    return this.config.groupTrigger === "" || text.trim().toLowerCase().startsWith(this.config.groupTrigger.toLowerCase());
  }

  private upsertRoute(routeKey: string, patch: Partial<RouteState>): RouteState {
    const current = this.state.getRoute(routeKey);
    const has = (key: keyof RouteState) => Object.prototype.hasOwnProperty.call(patch, key);
    return this.state.upsertRoute({
      routeKey,
      trusted: current?.trusted ?? !this.config.pairingRequired,
      pairedAt: current?.pairedAt,
      codexThreadId: has("codexThreadId") ? patch.codexThreadId : current?.codexThreadId,
      cwd: has("cwd") ? patch.cwd : current?.cwd,
      lastPrompt: has("lastPrompt") ? patch.lastPrompt : current?.lastPrompt,
      contextToken: has("contextToken") ? patch.contextToken : current?.contextToken,
      updatedAt: new Date().toISOString(),
    });
  }

  private async reply(message: InboundMessage, content: string): Promise<void> {
    const contextToken = message.contextToken ?? this.routeFor(message).contextToken;
    await this.weixin.sendText(message.conversationId, content, contextToken);
  }

  private async runCodexBackend(routeKey: string, prompt: string, attachmentNote: string, cwd: string, threadId?: string) {
    const preferNative = this.config.codexRunner === "app-server"
      || (this.config.codexRunner === "auto" && isImageArtifactRequest(prompt));
    if (preferNative) {
      try {
        return await this.nativeCodex.run(routeKey, {
          prompt: buildCodexPrompt(prompt, attachmentNote, true),
          cwd,
          threadId,
        });
      } catch (error) {
        console.warn(`[codex-app:${routeKey}] falling back to exec: ${sanitizeError(error)}`);
      }
    }
    return this.codex.run(routeKey, {
      prompt: buildCodexPrompt(prompt, attachmentNote, false),
      cwd,
      threadId,
      onProgress: (text) => {
        if (this.config.debug) console.error(`[codex:${routeKey}] ${text}`);
      },
    });
  }

  private async replyWithArtifacts(message: InboundMessage, prompt: string, cwd: string, text: string, extraArtifacts: string[] = []): Promise<void> {
    const contextToken = message.contextToken ?? this.routeFor(message).contextToken;
    const artifacts = uniqueArtifactPaths([...extraArtifacts, ...extractArtifactPaths(text, cwd)]);
    const imageRequest = isImageArtifactRequest(prompt);
    let replyText = normalizeWechatReply(stripArtifactDirectives(text));
    if (artifacts.length > 0 && imageRequest) {
      replyText = "已生成图片，下面发送。";
    } else if (artifacts.length === 0 && imageRequest) {
      const poster = await createFallbackPoster(prompt, cwd);
      artifacts.push(poster.path);
      if (!replyText || isPlaceholderArtifactReply(replyText)) replyText = posterReadyText(prompt);
    } else if (!replyText && artifacts.length > 0) {
      replyText = "已生成文件，下面发送。";
    } else if (!replyText) {
      replyText = normalizeWechatReply(text);
    }
    if (replyText) await this.weixin.sendText(message.conversationId, replyText, contextToken);
    for (const artifactPath of artifacts.slice(0, 3)) {
      try {
        await this.weixin.sendMedia(message.conversationId, artifactPath, contextToken);
      } catch (error) {
        await this.weixin.sendText(
          message.conversationId,
          `文件已生成，但发送到微信失败：${sanitizeError(error)}\n${artifactPath}`,
          contextToken,
        );
      }
    }
  }

  private setTyping(message: InboundMessage, status: number): void {
    if (message.conversationKind !== "direct") return;
    const contextToken = message.contextToken ?? this.routeFor(message).contextToken;
    void this.weixin.sendTyping(message.senderId, contextToken, status).catch((error) => {
      if (this.config.debug) console.error(`[weixin:typing] ${sanitizeError(error)}`);
    });
  }
}

function isImmediateMessage(message: InboundMessage): boolean {
  return Boolean(parsePairCommand(message.text) || parseCommand(message.text));
}

function shouldDelayInboundMessage(message: InboundMessage, mergeWindowMs: number): boolean {
  return mergeWindowMs > 0 && message.attachments.length > 0 && message.text.trim() === "";
}

function mergeInboundMessages(base: InboundMessage, next: InboundMessage): InboundMessage {
  return {
    ...next,
    routeKey: base.routeKey,
    accountId: base.accountId,
    conversationId: base.conversationId,
    conversationKind: base.conversationKind,
    senderId: next.senderId || base.senderId,
    messageId: [base.messageId, next.messageId].filter(Boolean).join("+"),
    text: mergeText(base.text, next.text),
    attachments: [...base.attachments, ...next.attachments],
    contextToken: next.contextToken ?? base.contextToken,
    timestamp: next.timestamp || base.timestamp,
  };
}

function mergeText(base: string, next: string): string {
  const left = base.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

function formatAttachmentForPrompt(item: InboundMessage["attachments"][number]): string {
  const parts = [`- ${item.kind}:${item.name ?? item.id}`];
  if (item.localPath) parts.push(`path=${item.localPath}`);
  if (item.mimeType) parts.push(`mime=${item.mimeType}`);
  if (item.sizeBytes) parts.push(`bytes=${item.sizeBytes}`);
  if (item.downloadError) parts.push(`download_error=${item.downloadError}`);
  return parts.join(" ");
}

function buildCodexPrompt(userPrompt: string, attachmentNote: string, nativeImageGeneration: boolean): string {
  const imageInstruction = nativeImageGeneration
    ? "- 如果用户要生成或编辑图片/海报，优先使用 imagegen skill / 原生图片生成能力。保存栅格图片，并返回保存后的文件路径。"
    : "- 当前 Codex CLI 环境不能直接调用 ChatGPT imagegen。图片/海报请求请在 ./wechat-codex-artifacts 下创建真实 SVG/PNG artifact，并以 `ARTIFACT: <absolute path>` 结束。";
  return [
    "微信回复风格：",
    "- 默认使用简体中文回复，尤其是用户只发图片/文件或语言不明确时；只有用户明确要求其他语言时才切换。",
    "- 直接给答案，不要长铺垫、元解释或内部实现细节。",
    "- 默认适合微信阅读：结论先行，然后 2-5 条短要点或短段落。",
    "- 常规回答尽量控制在 800 个中文字符以内，除非用户明确要求深入。",
    "- 避免表格和长链接列表；需要来源时，只放一行简短参考，最多 2 个链接。",
    "- 实时查询要给出结果对应的具体日期/时间和答案，少说免责声明。",
    "- 代码/服务器任务要概括结果、关键改动、验证结果，以及是否需要用户操作。",
    imageInstruction,
    "- 不要只回复“我会用 imagegen”这类未来计划；要实际创建 artifact，或明确说明无法创建的原因。",
    "",
    "User message:",
    userPrompt,
    attachmentNote,
  ].filter((part) => part !== "").join("\n");
}

function uniqueArtifactPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();
  for (const item of paths) {
    const normalized = path.resolve(item);
    const pathKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seenPaths.has(pathKey)) continue;
    const contentKey = artifactContentKey(normalized);
    if (contentKey && seenContent.has(contentKey)) continue;
    seenPaths.add(pathKey);
    if (contentKey) seenContent.add(contentKey);
    out.push(normalized);
  }
  return out;
}

function artifactContentKey(filePath: string): string | undefined {
  try {
    const realPath = fs.realpathSync.native(filePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return undefined;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(realPath)).digest("hex");
    return `${stat.size}:${hash}`;
  } catch {
    return undefined;
  }
}

function normalizeWechatReply(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line
      .replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, "$1$2")
      .replace(/([\p{Script=Han}])\s+([，。！？；：、）])/gu, "$1$2")
      .replace(/([（])\s+([\p{Script=Han}])/gu, "$1$2")
      .replace(/[ \t]{3,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatCodexFailure(error: unknown): string {
  const detail = sanitizeError(error);
  if (isCodexAuthError(detail)) {
    return `Codex 登录失败：服务器上的 Codex 登录态或 API 凭据不可用。\n\n细节：${detail}`;
  }
  if (isCodexConnectivityError(detail)) {
    return `Codex 连接失败：服务器暂时连不上 Codex/OpenAI 后端。请稍后重试；如果持续出现，需要检查服务器 DNS 或 HTTPS 代理。\n\n细节：${detail}`;
  }
  return `Codex 运行失败：${detail}`;
}

function isCodexAuthError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("401 unauthorized")
    || value.includes("missing bearer")
    || value.includes("not authenticated")
    || value.includes("please login");
}

function isCodexConnectivityError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("error sending request")
    || value.includes("tls handshake")
    || value.includes("connection reset")
    || value.includes("connection refused")
    || value.includes("connection timed out")
    || value.includes("network is unreachable")
    || value.includes("fetch failed")
    || value.includes("etimedout")
    || value.includes("econnreset");
}
