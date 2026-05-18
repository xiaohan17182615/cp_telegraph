import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/bridge/commands.js";

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
