import test from "node:test";
import assert from "node:assert/strict";
import { splitShellArgs } from "../src/util/shell-args.js";

test("splitShellArgs handles quotes", () => {
  assert.deepEqual(splitShellArgs('--json --cd "C:\\Work Dir"'), ["--json", "--cd", "C:\\Work Dir"]);
});

test("splitShellArgs keeps Windows path backslashes", () => {
  assert.deepEqual(splitShellArgs("C:\\Users\\me\\repo"), ["C:\\Users\\me\\repo"]);
});

test("splitShellArgs rejects unterminated quotes", () => {
  assert.throws(() => splitShellArgs('"missing'), /unterminated quote/);
});
