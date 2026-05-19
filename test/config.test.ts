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
  assert.equal(config.workingNotice, false);
  assert.equal(config.mediaMaxBytes, 100 * 1024 * 1024);
  assert.equal(config.codexRunner, "exec");
  assert.equal(config.codexModel, "gpt-5.5");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.deepEqual(config.codexExecArgs, [
    "--json",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=xhigh",
    "--skip-git-repo-check",
  ]);
  assert.deepEqual(config.codexResumeArgs, [
    "--json",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=xhigh",
    "--skip-git-repo-check",
    "--all",
  ]);
});

test("loadConfig parses args and tilde paths", () => {
  const config = loadConfig({
    WECHAT_CODEX_HOME: "~/bridge",
    WECHAT_CODEX_EXEC_ARGS: '--json --cd "C:\\Work Dir"',
    WECHAT_CODEX_GROUP_TRIGGER: "",
    WECHAT_CODEX_RUNNER: "native",
    WECHAT_CODEX_MODEL: "gpt-5.4",
    WECHAT_CODEX_REASONING_EFFORT: "high",
  } as NodeJS.ProcessEnv, process.cwd());
  assert.equal(config.homeDir, path.join(os.homedir(), "bridge"));
  assert.deepEqual(config.codexExecArgs, ["--json", "--cd", "C:\\Work Dir"]);
  assert.equal(config.groupTrigger, "");
  assert.equal(config.codexRunner, "app-server");
  assert.equal(config.codexModel, "gpt-5.4");
  assert.equal(config.codexReasoningEffort, "high");
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
