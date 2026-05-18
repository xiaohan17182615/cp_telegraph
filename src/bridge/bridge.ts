import path from "node:path";
import type { AppConfig } from "../config.js";
import { JsonStateStore, type RouteState } from "../state.js";
import { sanitizeError } from "../util/text.js";
import { WeixinAdapter, type InboundMessage } from "../weixin/adapter.js";
import { parseCommand, helpText } from "./commands.js";
import { CodexRunner } from "./codex-runner.js";
import { PairingManager, parsePairCommand } from "./pairing.js";

export class WechatCodexBridge {
  private readonly state: JsonStateStore;
  private readonly pairing = new PairingManager();
  private readonly codex: CodexRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly weixin: WeixinAdapter,
  ) {
    this.state = new JsonStateStore(path.join(config.stateDir, "bridge-state.json"));
    this.codex = new CodexRunner(config);
  }

  async start(): Promise<void> {
    await this.weixin.start((message) => this.handleMessage(message));
  }

  stop(): void {
    this.weixin.stop();
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const route = this.state.getRoute(message.routeKey);
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
      await this.weixin.sendText(message.conversationId, "Paired. This chat is now allowed to use Codex.");
      return;
    }
    await this.weixin.sendText(message.conversationId, `Pairing failed: ${result.reason}. Check the terminal for the latest code.`);
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
    await this.weixin.sendText(
      message.conversationId,
      "This WeChat chat is not paired yet. Check the terminal running wechat-codex, then send `/pair <code>` here.",
    );
  }

  private async handleCommand(message: InboundMessage, name: string, args: string[]): Promise<void> {
    if (name === "help") {
      await this.weixin.sendText(message.conversationId, helpText());
      return;
    }
    if (name === "status") {
      await this.weixin.sendText(message.conversationId, this.statusText(message));
      return;
    }
    if (name === "routes") {
      await this.weixin.sendText(message.conversationId, this.routesText());
      return;
    }
    if (name === "new") {
      const cwd = args.length > 0 ? path.resolve(args.join(" ")) : undefined;
      this.upsertRoute(message.routeKey, { codexThreadId: undefined, cwd });
      await this.weixin.sendText(message.conversationId, `New Codex thread will be used for this chat.${cwd ? `\ncwd: ${cwd}` : ""}`);
      return;
    }
    if (name === "cwd") {
      if (args.length === 0) {
        await this.weixin.sendText(message.conversationId, `Current cwd: ${this.routeFor(message).cwd ?? this.config.cwd}`);
        return;
      }
      const cwd = path.resolve(args.join(" "));
      this.upsertRoute(message.routeKey, { cwd });
      await this.weixin.sendText(message.conversationId, `Working directory set:\n${cwd}`);
      return;
    }
    if (name === "retry") {
      const lastPrompt = this.routeFor(message).lastPrompt;
      if (!lastPrompt) {
        await this.weixin.sendText(message.conversationId, "No previous prompt for this chat.");
        return;
      }
      await this.runCodex(message, lastPrompt);
      return;
    }
    if (name === "stop") {
      const stopped = this.codex.stop(message.routeKey);
      await this.weixin.sendText(message.conversationId, stopped ? "Stop signal sent to Codex." : "No running Codex task for this chat.");
      return;
    }
    await this.weixin.sendText(message.conversationId, `Unknown command: /${name}\nSend /help for available commands.`);
  }

  private async runCodex(message: InboundMessage, prompt: string): Promise<void> {
    if (this.codex.isBusy(message.routeKey)) {
      await this.weixin.sendText(message.conversationId, "Codex is still working on this chat. Send /stop to interrupt, or wait for the result.");
      return;
    }
    const route = this.routeFor(message);
    const cwd = route.cwd ?? this.config.cwd;
    this.upsertRoute(message.routeKey, { lastPrompt: prompt, cwd });
    await this.weixin.sendText(message.conversationId, "Codex is working...");
    try {
      const attachmentNote = message.attachments.length > 0
        ? `\n\nIncoming WeChat attachments: ${message.attachments.map((item) => `${item.kind}:${item.name ?? item.id}`).join(", ")}`
        : "";
      const result = await this.codex.run(message.routeKey, {
        prompt: `${prompt}${attachmentNote}`,
        cwd,
        threadId: route.codexThreadId,
        onProgress: (text) => {
          if (this.config.debug) console.error(`[codex:${message.routeKey}] ${text}`);
        },
      });
      this.upsertRoute(message.routeKey, { codexThreadId: result.threadId, cwd });
      await this.weixin.sendText(message.conversationId, result.text);
    } catch (error) {
      await this.weixin.sendText(message.conversationId, `Codex failed: ${sanitizeError(error)}`);
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
      `busy: ${this.codex.isBusy(message.routeKey) ? "yes" : "no"}`,
      `cwd: ${route.cwd ?? this.config.cwd}`,
      `codex_thread: ${route.codexThreadId ?? "new"}`,
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
      updatedAt: new Date().toISOString(),
    });
  }
}
