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

export class WechatCodexBridge {
  private readonly state: JsonStateStore;
  private readonly pairing = new PairingManager();
  private readonly codex: CodexRunner;
  private readonly nativeCodex: CodexAppRunner;

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
    for (const route of this.state.listRoutes()) this.nativeCodex.stop(route.routeKey);
    this.weixin.stop();
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
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

  private async handlePair(message: InboundMessage, code: string): Promise<void> {
    const result = this.pairing.verify(message.routeKey, code);
    if (result.ok) {
      this.state.trustRoute(message.routeKey);
      await this.reply(message, "Paired. This chat is now allowed to use Codex.");
      return;
    }
    await this.reply(message, `Pairing failed: ${result.reason}. Check the terminal for the latest code.`);
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
    await this.reply(message, "This WeChat chat is not paired yet. Check the terminal running wechat-codex, then send `/pair <code>` here.");
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
      await this.reply(message, `New Codex thread will be used for this chat.${cwd ? `\ncwd: ${cwd}` : ""}`);
      return;
    }
    if (name === "cwd") {
      if (args.length === 0) {
        await this.reply(message, `Current cwd: ${this.routeFor(message).cwd ?? this.config.cwd}`);
        return;
      }
      const cwd = path.resolve(args.join(" "));
      this.upsertRoute(message.routeKey, { cwd });
      await this.reply(message, `Working directory set:\n${cwd}`);
      return;
    }
    if (name === "retry") {
      const lastPrompt = this.routeFor(message).lastPrompt;
      if (!lastPrompt) {
        await this.reply(message, "No previous prompt for this chat.");
        return;
      }
      await this.runCodex(message, lastPrompt);
      return;
    }
    if (name === "stop") {
      const stopped = this.codex.stop(message.routeKey) || this.nativeCodex.stop(message.routeKey);
      await this.reply(message, stopped ? "Stop signal sent to Codex." : "No running Codex task for this chat.");
      return;
    }
    await this.reply(message, `Unknown command: /${name}\nSend /help for available commands.`);
  }

  private async runCodex(message: InboundMessage, prompt: string): Promise<void> {
    if (this.codex.isBusy(message.routeKey) || this.nativeCodex.isBusy(message.routeKey)) {
      await this.reply(message, "Codex is still working on this chat. Send /stop to interrupt, or wait for the result.");
      return;
    }
    const route = this.routeFor(message);
    const cwd = route.cwd ?? this.config.cwd;
    this.upsertRoute(message.routeKey, { lastPrompt: prompt, cwd });
    if (this.config.workingNotice) await this.reply(message, "Codex is working...");
    this.setTyping(message, TypingStatus.TYPING);
    try {
      const attachmentNote = message.attachments.length > 0
        ? `\n\nIncoming WeChat attachments:\n${message.attachments.map(formatAttachmentForPrompt).join("\n")}`
        : "";
      const result = await this.runCodexBackend(message.routeKey, prompt, attachmentNote, cwd, route.codexThreadId);
      this.upsertRoute(message.routeKey, { codexThreadId: result.threadId, cwd });
      await this.replyWithArtifacts(message, prompt, cwd, result.text, result.artifacts);
    } catch (error) {
      await this.reply(message, `Codex failed: ${sanitizeError(error)}`);
    } finally {
      this.setTyping(message, TypingStatus.CANCEL);
    }
  }

  private statusText(message: InboundMessage): string {
    const route = this.routeFor(message);
    const wx = this.weixin.status();
    return [
      "Bridge status",
      `wechat: ${wx.account ?? "not logged in"}`,
      `route: ${message.routeKey}`,
      `paired: ${route.trusted ? "yes" : "no"}`,
      `busy: ${this.codex.isBusy(message.routeKey) || this.nativeCodex.isBusy(message.routeKey) ? "yes" : "no"}`,
      `runner: ${this.config.codexRunner}`,
      `cwd: ${route.cwd ?? this.config.cwd}`,
      `codex_thread: ${route.codexThreadId ?? "new"}`,
      `context_token: ${route.contextToken ? "cached" : "none"}`,
      `working_notice: ${this.config.workingNotice ? "on" : "off"}`,
    ].join("\n");
  }

  private routesText(): string {
    const routes = this.state.listRoutes().slice(0, 20);
    if (routes.length === 0) return "No routes yet.";
    return routes.map((route, index) => [
      `${index + 1}. ${route.routeKey}`,
      `   paired=${route.trusted ? "yes" : "no"} thread=${route.codexThreadId ?? "new"}`,
      `   updated=${route.updatedAt}`,
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
        if (this.config.debug) console.error(`[codex-app:${routeKey}] falling back to exec: ${sanitizeError(error)}`);
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
    const artifacts = [...extraArtifacts, ...extractArtifactPaths(text, cwd)];
    let replyText = stripArtifactDirectives(text);
    if (artifacts.length === 0 && isImageArtifactRequest(prompt)) {
      const poster = await createFallbackPoster(prompt, cwd);
      artifacts.push(poster.path);
      if (!replyText || isPlaceholderArtifactReply(replyText)) replyText = posterReadyText(prompt);
    } else if (!replyText && artifacts.length > 0) {
      replyText = "已生成文件，下面发送。";
    } else if (!replyText) {
      replyText = text.trim();
    }
    if (replyText) await this.weixin.sendText(message.conversationId, replyText, contextToken);
    for (const artifactPath of artifacts.slice(0, 3)) {
      try {
        await this.weixin.sendMedia(message.conversationId, artifactPath, contextToken);
      } catch (error) {
        await this.weixin.sendText(
          message.conversationId,
          `Artifact generated but media send failed: ${sanitizeError(error)}\n${artifactPath}`,
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
    ? "- For poster/image requests, use the imagegen skill / native image generation when available. Save the generated raster image and return the saved file path."
    : "- This Codex CLI environment cannot call ChatGPT imagegen. For poster/image requests, create a real local SVG/PNG artifact under ./wechat-codex-artifacts and finish with `ARTIFACT: <absolute path>`.";
  return [
    "WeChat reply style:",
    "- Reply in the user's language unless they ask otherwise.",
    "- Put the direct answer first. Avoid long preambles, meta commentary, and internal implementation details.",
    "- Default to a compact WeChat shape: conclusion first, then 2-5 short bullets or short paragraphs.",
    "- Keep routine answers under about 800 Chinese characters or 500 English words unless the user asks for depth.",
    "- Avoid tables and long link lists. If sources are useful, add one short reference line with at most 2 links.",
    "- For real-time lookups, say the exact date/time of the result and the answer; keep caveats short.",
    "- For code/server work, summarize outcome, key changed paths, verification result, and any required user action.",
    imageInstruction,
    "- Never reply only with future-tense tool plans such as 'I will use imagegen'. Create the artifact or clearly say why it cannot be created.",
    "",
    "User message:",
    userPrompt,
    attachmentNote,
  ].filter((part) => part !== "").join("\n");
}
