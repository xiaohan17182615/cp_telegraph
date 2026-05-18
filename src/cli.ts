#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { JsonStateStore } from "./state.js";
import { WechatCodexBridge } from "./bridge/bridge.js";
import { WeixinAccountStore } from "./weixin/account-store.js";
import { WeixinAdapter } from "./weixin/adapter.js";
import { WeixinClient } from "./weixin/client.js";
import { runQrLogin } from "./weixin/login.js";
import { printQrToTerminal } from "./weixin/qr.js";

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  if (command === "login") {
    await login();
    return;
  }
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "status") {
    status();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "routes") {
    routes(Number.parseInt(rest[0] ?? "20", 10) || 20);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

async function login(): Promise<void> {
  const config = loadConfig();
  const client = new WeixinClient({ baseUrl: config.baseUrl });
  const store = new WeixinAccountStore(config.accountsDir);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const account = await runQrLogin({
      client,
      store,
      botType: config.botType,
      askVerifyCode: (prompt) => rl.question(prompt),
      onQr: async (qrText) => {
        console.log("Scan this QR code with WeChat:");
        await printQrToTerminal(qrText);
      },
      onStatus: (statusText) => console.log(`WeChat login status: ${statusText}`),
    });
    console.log(`Saved WeChat account: ${account.accountId}`);
    console.log(`State directory: ${config.stateDir}`);
  } finally {
    rl.close();
  }
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const adapter = new WeixinAdapter(config);
  const bridge = new WechatCodexBridge(config, adapter);

  const stop = (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}; stopping bridge...`);
    bridge.stop();
    setTimeout(() => process.exit(0), 600).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log("wechat-codex bridge starting");
  console.log(`cwd: ${config.cwd}`);
  console.log(`state: ${config.stateDir}`);
  console.log(`pairing: ${config.pairingRequired ? "required" : "disabled"}`);
  console.log(`group trigger: ${config.groupTrigger || "(disabled)"}`);
  await bridge.start();
}

function status(): void {
  const config = loadConfig();
  const store = new WeixinAccountStore(config.accountsDir);
  const accountIds = store.listAccountIds();
  const account = store.getDefaultAccount();
  const state = new JsonStateStore(path.join(config.stateDir, "bridge-state.json")).read();
  console.log([
    "wechat-codex status",
    `version: ${VERSION}`,
    `node: ${process.version}`,
    `home: ${config.homeDir}`,
    `state: ${config.stateDir}`,
    `cwd: ${config.cwd}`,
    `codex: ${config.codexBin}`,
    `accounts: ${accountIds.length}`,
    `default_account: ${account?.accountId ?? "none"}`,
    `routes: ${state.routes.length}`,
    `pairing_required: ${config.pairingRequired ? "yes" : "no"}`,
    `group_trigger: ${config.groupTrigger || "(disabled)"}`,
  ].join("\n"));
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  const nodeOk = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22;
  console.log(`node >= 22: ${nodeOk ? "ok" : `failed (${process.version})`}`);
  console.log(`home: ${config.homeDir}`);
  console.log(`state writable: ${isWritable(config.stateDir) ? "ok" : "failed"}`);
  const codex = await runProcess(config.codexBin, ["--version"], config.cwd, 15_000);
  if (codex.ok) {
    console.log(`codex: ok (${(codex.stdout || codex.stderr).trim() || config.codexBin})`);
  } else {
    console.log(`codex: failed (${codex.error || codex.stderr || `exit ${codex.code}`})`);
  }
  const store = new WeixinAccountStore(config.accountsDir);
  console.log(`wechat account: ${store.getDefaultAccount()?.accountId ?? "not logged in"}`);
}

function routes(limit: number): void {
  const config = loadConfig();
  const state = new JsonStateStore(path.join(config.stateDir, "bridge-state.json"));
  const items = state.listRoutes().slice(0, limit);
  if (items.length === 0) {
    console.log("No routes yet.");
    return;
  }
  for (const route of items) {
    console.log([
      route.routeKey,
      `  trusted: ${route.trusted ? "yes" : "no"}`,
      `  cwd: ${route.cwd ?? config.cwd}`,
      `  thread: ${route.codexThreadId ?? "new"}`,
      `  updated: ${route.updatedAt}`,
    ].join("\n"));
  }
}

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{
  ok: boolean;
  code?: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      });
    } catch (error) {
      resolve({ ok: false, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, stdout, stderr, error: "timed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function usage(): string {
  return [
    "wechat-codex-bridge",
    "",
    "Usage:",
    "  wechat-codex login          Scan QR code and save WeChat token",
    "  wechat-codex serve          Start the WeChat to Codex bridge",
    "  wechat-codex status         Print local state summary",
    "  wechat-codex doctor         Check Node, Codex CLI, and state directory",
    "  wechat-codex routes [n]     List known WeChat routes",
    "",
    "Common environment variables:",
    "  WECHAT_CODEX_CWD=/path/to/workspace",
    "  WECHAT_CODEX_BIN=codex",
    "  WECHAT_CODEX_PAIRING_REQUIRED=true",
    "  WECHAT_CODEX_GROUP_TRIGGER=@codex",
    "  WECHAT_CODEX_HOME=~/.wechat-codex-bridge",
  ].join("\n");
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
