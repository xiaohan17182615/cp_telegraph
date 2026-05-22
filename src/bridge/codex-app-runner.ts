import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { CodexRunInput, CodexRunResult } from "./codex-runner.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  routeKey: string;
  threadId: string;
  turnId: string;
  textParts: string[];
  artifacts: string[];
  rawLines: string[];
  retryableErrors: number;
  resolve: (result: CodexRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppRunner {
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeByRoute = new Map<string, ActiveTurn>();
  private readonly activeByTurn = new Map<string, ActiveTurn>();
  private stderrTail = "";

  constructor(private readonly config: AppConfig) {}

  isBusy(routeKey: string): boolean {
    return this.activeByRoute.has(routeKey);
  }

  stop(routeKey: string): boolean {
    const active = this.activeByRoute.get(routeKey);
    if (!active) return false;
    this.rejectTurn(active, new Error("已向 Codex app-server 发送停止信号。"));
    this.restart();
    return true;
  }

  async run(routeKey: string, input: CodexRunInput): Promise<CodexRunResult> {
    if (this.activeByRoute.has(routeKey)) throw new Error("route is already running");
    await this.start();
    const threadId = input.threadId
      ? await this.resumeThread(input.threadId, input.cwd).catch(() => this.startThread(input.cwd))
      : await this.startThread(input.cwd);
    const turn = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      model: this.config.codexModel,
      effort: this.config.codexReasoningEffort,
      approvalPolicy: "never",
    }, 30_000) as { turn?: { id?: string } };
    const turnId = turn.turn?.id;
    if (!turnId) throw new Error("Codex app-server returned no turn id");
    return new Promise<CodexRunResult>((resolve, reject) => {
      const active: ActiveTurn = {
        routeKey,
        threadId,
        turnId,
        textParts: [],
        artifacts: [],
        rawLines: [],
        retryableErrors: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.rejectTurn(active, new Error("Timed out waiting for Codex app-server turn"));
        }, this.config.codexAppServerTimeoutMs),
      };
      this.activeByRoute.set(routeKey, active);
      this.activeByTurn.set(turnId, active);
      if (input.signal) {
        input.signal.addEventListener("abort", () => this.stop(routeKey), { once: true });
      }
    });
  }

  private async startThread(cwd: string): Promise<string> {
    const response = await this.request("thread/start", {
      cwd,
      model: this.config.codexModel,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: this.config.codexReasoningEffort },
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    }, 30_000) as { thread?: { id?: string } };
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("Codex app-server returned no thread id");
    return threadId;
  }

  private async resumeThread(threadId: string, cwd: string): Promise<string> {
    await this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "never",
      baseInstructions: null,
      developerInstructions: null,
      config: { model_reasoning_effort: this.config.codexReasoningEffort },
      sandbox: "workspace-write",
      model: this.config.codexModel,
      modelProvider: null,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    }, 30_000);
    return threadId;
  }

  private async start(): Promise<void> {
    if (this.initialized && this.child?.stdin.writable) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = undefined;
    });
    await this.startPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    this.initialized = false;
    this.stderrTail = "";
    const child = spawn(this.config.codexBin, [...this.config.codexRootArgs, "app-server"], {
      cwd: this.config.cwd,
      env: process.env,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.config.codexBin),
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000);
    });
    child.once("exit", () => {
      this.initialized = false;
      this.rejectAll(new Error(`Codex app-server exited.${this.stderrTail ? ` ${this.stderrTail.trim()}` : ""}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "wechat-codex-bridge", title: "WeChat Codex Bridge", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "codex/event/agent_reasoning_delta",
          "codex/event/reasoning_content_delta",
          "codex/event/reasoning_raw_content_delta",
          "codex/event/exec_command_output_delta",
        ],
      },
    }, 30_000);
    this.send({ jsonrpc: "2.0", method: "initialized" });
    this.initialized = true;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(payload: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const parsed = parseJson(line);
    if (!parsed) return;
    const raw = JSON.stringify(parsed);
    if ("id" in parsed && !("method" in parsed)) {
      const pending = this.pending.get(String(parsed.id));
      if (!pending) return;
      this.pending.delete(String(parsed.id));
      clearTimeout(pending.timer);
      const error = parsed.error as { message?: string } | undefined;
      if (error) pending.reject(new Error(error.message || "Codex app-server JSON-RPC error"));
      else pending.resolve(parsed.result);
      return;
    }
    if (typeof parsed.method !== "string") return;
    const active = activeTurnForNotification(parsed, this.activeByTurn);
    if (active) active.rawLines.push(raw);
    this.handleNotification(parsed, active);
    if ("id" in parsed) {
      this.send({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "WeChat bridge does not handle interactive app-server requests" },
      });
    }
  }

  private handleNotification(message: Record<string, unknown>, active: ActiveTurn | undefined): void {
    const method = String(message.method);
    const params = objectField(message, "params");
    if (active && method === "item/completed") {
      const item = objectField(params, "item");
      const text = textFromThreadItem(item);
      if (text) active.textParts.push(text);
      for (const artifact of artifactsFromThreadItem(item)) active.artifacts.push(artifact);
    }
    if (active && method === "error") {
      const willRetry = booleanField(params, "willRetry");
      const error = objectField(params, "error");
      const messageText = stringField(error, "message")
        || stringField(params, "message")
        || "Codex app-server turn failed";
      if (willRetry && isFatalCodexError(messageText)) {
        this.rejectTurn(active, new Error(messageText));
        this.restart();
        return;
      }
      if (willRetry && isRetryableNetworkError(messageText)) {
        active.retryableErrors += 1;
        if (active.retryableErrors >= 3) {
          this.rejectTurn(
            active,
            new Error(`Codex app-server network error after ${active.retryableErrors} retries: ${messageText}`),
          );
          this.restart();
        }
        return;
      }
      if (!willRetry) {
        this.rejectTurn(active, new Error(messageText));
      }
    }
    if (active && method === "turn/completed") {
      this.resolveTurn(active);
    }
  }

  private resolveTurn(active: ActiveTurn): void {
    this.clearTurn(active);
    active.resolve({
      text: normalizeText(active.textParts, active.artifacts),
      threadId: active.threadId,
      rawLines: active.rawLines,
      artifacts: dedupe(active.artifacts),
    });
  }

  private rejectTurn(active: ActiveTurn, error: Error): void {
    this.clearTurn(active);
    active.reject(error);
  }

  private clearTurn(active: ActiveTurn): void {
    clearTimeout(active.timer);
    this.activeByRoute.delete(active.routeKey);
    this.activeByTurn.delete(active.turnId);
  }

  private restart(): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref?.();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const active of this.activeByRoute.values()) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    this.activeByRoute.clear();
    this.activeByTurn.clear();
  }
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function activeTurnForNotification(message: Record<string, unknown>, activeByTurn: Map<string, ActiveTurn>): ActiveTurn | undefined {
  const params = objectField(message, "params");
  const turnId = stringField(params, "turnId") || stringField(objectField(params, "turn"), "id");
  return turnId ? activeByTurn.get(turnId) : undefined;
}

function objectField(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(source: Record<string, unknown> | undefined, key: string): boolean {
  return source?.[key] === true;
}

function textFromThreadItem(item: Record<string, unknown> | undefined): string | undefined {
  if (item?.type === "agentMessage") return stringField(item, "text");
  return undefined;
}

export function artifactsFromThreadItem(item: Record<string, unknown> | undefined): string[] {
  if (!item) return [];
  if (item.type !== "imageGeneration") return [];
  const savedPath = stringField(item, "savedPath");
  const result = stringField(item, "result");
  const artifactPath = savedPath || result;
  return artifactPath && path.isAbsolute(artifactPath) ? [artifactPath] : [];
}

function normalizeText(textParts: string[], artifacts: string[]): string {
  const text = dedupe(textParts.map((part) => part.trim()).filter(Boolean)).join("\n").trim();
  if (text) return text;
  return artifacts.length > 0 ? "已生成图片，下面发送。" : "Codex finished without a visible final answer.";
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function isFatalCodexError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("401 unauthorized")
    || value.includes("missing bearer")
    || value.includes("not authenticated")
    || value.includes("please login");
}

function isRetryableNetworkError(message: string): boolean {
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
