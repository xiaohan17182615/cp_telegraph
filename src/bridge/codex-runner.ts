import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AppConfig } from "../config.js";

export interface CodexRunInput {
  prompt: string;
  cwd: string;
  threadId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface CodexRunResult {
  text: string;
  threadId?: string;
  rawLines: string[];
  artifacts?: string[];
}

export class CodexRunner {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly config: AppConfig) {}

  isBusy(routeKey: string): boolean {
    return this.active.has(routeKey);
  }

  stop(routeKey: string): boolean {
    const child = this.active.get(routeKey);
    if (!child) return false;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3000).unref?.();
    return true;
  }

  async run(routeKey: string, input: CodexRunInput): Promise<CodexRunResult> {
    if (this.active.has(routeKey)) throw new Error("route is already running");
    const args = this.buildArgs(input);
    const child = spawn(this.config.codexBin, args, {
      cwd: input.cwd,
      env: process.env,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.config.codexBin),
    });
    child.stdin.end();
    this.active.set(routeKey, child);
    if (input.signal) {
      input.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }

    const rawLines: string[] = [];
    const plainLines: string[] = [];
    const assistantTexts: string[] = [];
    let threadId = input.threadId;
    let stderr = "";

    const stdoutDone = consumeLines(child.stdout, (line) => {
      rawLines.push(line);
      const parsed = parseJsonLine(line);
      if (!parsed) {
        if (line.trim()) plainLines.push(line);
        return;
      }
      threadId = pickThreadId(parsed) ?? threadId;
      const progress = pickProgressText(parsed);
      if (progress) input.onProgress?.(progress);
      const text = pickAssistantText(parsed);
      if (text) assistantTexts.push(text);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    await stdoutDone;
    this.active.delete(routeKey);
    if (code !== 0) {
      throw new Error(stderr.trim() || `codex exited with code ${code}`);
    }
    return {
      text: normalizeFinalText(assistantTexts, plainLines),
      threadId,
      rawLines,
    };
  }

  private buildArgs(input: CodexRunInput): string[] {
    if (input.threadId) {
      return [
        ...this.config.codexRootArgs,
        "exec",
        "resume",
        ...this.config.codexResumeArgs,
        input.threadId,
        input.prompt,
      ];
    }
    return [
      ...this.config.codexRootArgs,
      "exec",
      ...this.config.codexExecArgs,
      "--cd",
      input.cwd,
      input.prompt,
    ];
  }
}

function consumeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): Promise<void> {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", onLine);
  return new Promise((resolve) => rl.once("close", resolve));
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickThreadId(event: Record<string, unknown>): string | undefined {
  for (const key of ["thread_id", "threadId", "session_id", "sessionId", "conversation_id"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = event["session"] ?? event["thread"] ?? event["response"];
  if (nested && typeof nested === "object") return pickThreadId(nested as Record<string, unknown>);
  return undefined;
}

function pickProgressText(event: Record<string, unknown>): string | undefined {
  const type = String(event.type ?? event.event ?? "");
  if (!/(reasoning|progress|plan|command)/i.test(type)) return undefined;
  return stringField(event, ["text", "summary", "summary_text", "message"]);
}

function pickAssistantText(event: Record<string, unknown>): string | undefined {
  const type = String(event.type ?? event.event ?? "");
  if (/(error|failed|reasoning|progress|command)/i.test(type)) return undefined;
  const direct = stringField(event, ["final", "final_text", "answer", "text", "message", "content"]);
  if (direct && /(assistant|message|final|response|output|turn\.completed|item\.completed)/i.test(type)) return direct;
  const item = event["item"];
  if (item && typeof item === "object") {
    const nested = pickAssistantText(item as Record<string, unknown>);
    if (nested) return nested;
  }
  const output = event["output"];
  if (Array.isArray(output)) {
    return output.map((entry) => typeof entry === "object" ? pickAssistantText(entry as Record<string, unknown>) : "").filter(Boolean).join("\n");
  }
  return undefined;
}

function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") return stringField(entry as Record<string, unknown>, ["text", "content"]);
        return "";
      }).filter(Boolean).join("\n");
      if (joined.trim()) return joined.trim();
    }
  }
  return undefined;
}

function normalizeFinalText(assistantTexts: string[], plainLines: string[]): string {
  const candidates = assistantTexts.map((text) => text.trim()).filter(Boolean);
  if (candidates.length > 0) return dedupeCumulative(candidates).join("\n").trim();
  return plainLines.join("\n").trim() || "Codex finished without a visible final answer.";
}

function dedupeCumulative(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const last = out.at(-1);
    if (last && value.startsWith(last)) {
      out[out.length - 1] = value;
    } else if (!last || last !== value) {
      out.push(value);
    }
  }
  return out;
}
