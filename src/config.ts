import os from "node:os";
import path from "node:path";
import { splitShellArgs } from "./util/shell-args.js";

export interface AppConfig {
  homeDir: string;
  stateDir: string;
  accountsDir: string;
  uploadsDir: string;
  cwd: string;
  codexBin: string;
  codexRootArgs: string[];
  codexExecArgs: string[];
  codexResumeArgs: string[];
  codexRunner: "exec" | "app-server" | "auto";
  codexModel: string;
  codexReasoningEffort: string;
  codexAppServerTimeoutMs: number;
  botAgent: string;
  pairingRequired: boolean;
  botType: string;
  baseUrl: string;
  cdnBaseUrl: string;
  minSendIntervalMs: number;
  maxMessageBytes: number;
  longPollTimeoutMs: number;
  downloadMedia: boolean;
  mediaMaxBytes: number;
  typingEnabled: boolean;
  workingNotice: boolean;
  groupTrigger: string;
  debug: boolean;
}

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_CODEX_EXEC_ARGS = '--json -m gpt-5.5 -c model_reasoning_effort="xhigh" --skip-git-repo-check';
const DEFAULT_CODEX_RESUME_ARGS = '--json -m gpt-5.5 -c model_reasoning_effort="xhigh" --skip-git-repo-check --all';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const homeDir = resolvePath(env.WECHAT_CODEX_HOME, cwd)
    ?? path.join(os.homedir(), ".wechat-codex-bridge");
  const stateDir = resolvePath(env.WECHAT_CODEX_STATE_DIR, cwd)
    ?? path.join(homeDir, "state");
  return {
    homeDir,
    stateDir,
    accountsDir: resolvePath(env.WECHAT_CODEX_ACCOUNTS_DIR, cwd) ?? path.join(stateDir, "weixin", "accounts"),
    uploadsDir: resolvePath(env.WECHAT_CODEX_UPLOADS_DIR, cwd) ?? path.join(stateDir, "uploads"),
    cwd: resolvePath(env.WECHAT_CODEX_CWD, cwd) ?? cwd,
    codexBin: env.CODEX_BIN?.trim() || env.WECHAT_CODEX_BIN?.trim() || "codex",
    codexRootArgs: splitShellArgs(env.WECHAT_CODEX_ROOT_ARGS),
    codexExecArgs: splitShellArgs(env.WECHAT_CODEX_EXEC_ARGS || DEFAULT_CODEX_EXEC_ARGS),
    codexResumeArgs: splitShellArgs(env.WECHAT_CODEX_RESUME_ARGS || DEFAULT_CODEX_RESUME_ARGS),
    codexRunner: parseRunner(env.WECHAT_CODEX_RUNNER),
    codexModel: env.WECHAT_CODEX_MODEL?.trim() || "gpt-5.5",
    codexReasoningEffort: env.WECHAT_CODEX_REASONING_EFFORT?.trim() || "xhigh",
    codexAppServerTimeoutMs: positiveInt(env.WECHAT_CODEX_APP_SERVER_TIMEOUT_MS, 15 * 60 * 1000),
    botAgent: sanitizeBotAgent(env.WECHAT_CODEX_BOT_AGENT || "WechatCodexBridge/0.1.0"),
    pairingRequired: parseBoolean(env.WECHAT_CODEX_PAIRING_REQUIRED, true),
    botType: env.WECHAT_CODEX_BOT_TYPE?.trim() || "3",
    baseUrl: trimTrailingSlash(env.WECHAT_CODEX_BASE_URL || DEFAULT_BASE_URL),
    cdnBaseUrl: trimTrailingSlash(env.WECHAT_CODEX_CDN_BASE_URL || DEFAULT_CDN_BASE_URL),
    minSendIntervalMs: positiveInt(env.WECHAT_CODEX_MIN_SEND_INTERVAL_MS, 1500),
    maxMessageBytes: positiveInt(env.WECHAT_CODEX_MAX_MESSAGE_BYTES, 1800),
    longPollTimeoutMs: positiveInt(env.WECHAT_CODEX_LONG_POLL_TIMEOUT_MS, 35_000),
    downloadMedia: parseBoolean(env.WECHAT_CODEX_DOWNLOAD_MEDIA, true),
    mediaMaxBytes: positiveInt(env.WECHAT_CODEX_MEDIA_MAX_BYTES, 100 * 1024 * 1024),
    typingEnabled: parseBoolean(env.WECHAT_CODEX_TYPING_ENABLED, true),
    workingNotice: parseBoolean(env.WECHAT_CODEX_WORKING_NOTICE, false),
    groupTrigger: env.WECHAT_CODEX_GROUP_TRIGGER === undefined ? "@codex" : env.WECHAT_CODEX_GROUP_TRIGGER.trim(),
    debug: parseBoolean(env.WECHAT_CODEX_DEBUG, false),
  };
}

function resolvePath(value: string | undefined, cwd: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === "~" || normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  return path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseRunner(value: string | undefined): AppConfig["codexRunner"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "app-server" || normalized === "app_server" || normalized === "native") return "app-server";
  if (normalized === "auto") return "auto";
  return "exec";
}

function sanitizeBotAgent(value: string): string {
  const fallback = "WechatCodexBridge/0.1.0";
  const matches = value.match(/[A-Za-z][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*(?: \([ !#-'*-[\]-~]{0,128}\))?/g) ?? [];
  const parts: string[] = [];
  for (const match of matches) {
    const next = [...parts, match].join(" ");
    if (Buffer.byteLength(next, "utf8") > 256) break;
    parts.push(match);
  }
  return parts.join(" ") || fallback;
}
