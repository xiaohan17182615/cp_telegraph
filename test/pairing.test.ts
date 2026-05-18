import test from "node:test";
import assert from "node:assert/strict";
import { PairingManager, parsePairCommand } from "../src/bridge/pairing.js";

test("parsePairCommand extracts six digit codes", () => {
  assert.equal(parsePairCommand("/pair 123456"), "123456");
  assert.equal(parsePairCommand("pair 123456"), "123456");
  assert.equal(parsePairCommand("/pair 12345"), null);
});

test("PairingManager verifies a live challenge once", () => {
  const manager = new PairingManager(60_000);
  const challenge = manager.getOrCreate("route-a");
  assert.equal(manager.verify("route-a", "000000").ok, false);
  assert.equal(manager.verify("route-a", challenge.code).ok, true);
  assert.equal(manager.verify("route-a", challenge.code).ok, false);
});
