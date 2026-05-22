import test from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand } from "../src/bridge/commands.js";

test("parseCommand recognizes aliases", () => {
  assert.equal(parseCommand("/st")?.name, "status");
  assert.equal(parseCommand("/cd C:\\Repo")?.name, "cwd");
});

test("parseCommand preserves quoted args", () => {
  assert.deepEqual(parseCommand('/new "C:\\Work Dir"')?.args, ["C:\\Work Dir"]);
});

test("parseCommand ignores normal prompts", () => {
  assert.equal(parseCommand("hello codex"), null);
});

test("helpText is Chinese by default", () => {
  const text = helpText();
  assert.match(text, /微信 Codex Bridge 命令/);
  assert.match(text, /\/status - 查看当前聊天状态/);
  assert.match(text, /直接发送普通消息即可运行 Codex/);
});
