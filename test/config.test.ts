import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("loadConfig applies safe defaults", () => {
  const config = loadConfig({}, process.cwd());
  assert.equal(config.pairingRequired, true);
  assert.equal(config.groupTrigger, "@codex");
  assert.equal(config.botAgent, "WechatCodexBridge/0.1.0");
  assert.equal(config.downloadMedia, true);
  assert.equal(config.typingEnabled, true);
  assert.equal(config.mediaMaxBytes, 100 * 1024 * 1024);
  assert.deepEqual(config.codexExecArgs, ["--json", "--skip-git-repo-check"]);
});

test("loadConfig parses args and tilde paths", () => {
  const config = loadConfig({
    WECHAT_CODEX_HOME: "~/bridge",
    WECHAT_CODEX_EXEC_ARGS: '--json --cd "C:\\Work Dir"',
    WECHAT_CODEX_GROUP_TRIGGER: "",
  } as NodeJS.ProcessEnv, process.cwd());
  assert.equal(config.homeDir, path.join(os.homedir(), "bridge"));
  assert.deepEqual(config.codexExecArgs, ["--json", "--cd", "C:\\Work Dir"]);
  assert.equal(config.groupTrigger, "");
});

test("loadConfig sanitizes bot agent as official UA tokens", () => {
  const config = loadConfig({
    WECHAT_CODEX_BOT_AGENT: "无效 MyBot/1.2.0 (region=cn;env=prod) bad Also/2",
  } as NodeJS.ProcessEnv, process.cwd());
  assert.equal(config.botAgent, "MyBot/1.2.0 (region=cn;env=prod) Also/2");

  const fallback = loadConfig({
    WECHAT_CODEX_BOT_AGENT: "not-a-valid-agent",
  } as NodeJS.ProcessEnv, process.cwd());
  assert.equal(fallback.botAgent, "WechatCodexBridge/0.1.0");
});
