import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { WechatCodexBridge } from "../src/bridge/bridge.js";
import { WeixinAdapter, type InboundMessage } from "../src/weixin/adapter.js";

test("bridge merges image-only messages with the next text message", async () => {
  const { bridge, runs, sentText, tmp } = createBridge(50);
  const imagePath = path.join(tmp, "page-172.jpg");
  fs.writeFileSync(imagePath, "fake image");

  await callHandleMessage(bridge, inboundMessage({
    messageId: "img-1",
    text: "",
    attachments: [{ id: "image-1", kind: "image", localPath: imagePath, raw: {} }],
  }));
  assert.equal(runs.length, 0);

  await callHandleMessage(bridge, inboundMessage({
    messageId: "txt-1",
    text: "将这几张图片的答案汇总成docx，只需要答案，不需要解析",
  }));

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.prompt, "将这几张图片的答案汇总成docx，只需要答案，不需要解析");
  assert.match(runs[0]?.attachmentNote ?? "", /page-172\.jpg/);
  assert.deepEqual(sentText, ["done"]);
  bridge.stop();
});

test("bridge flushes attachment-only messages after the merge window", async () => {
  const { bridge, runs, tmp } = createBridge(20);
  const imagePath = path.join(tmp, "only-image.jpg");
  fs.writeFileSync(imagePath, "fake image");

  await callHandleMessage(bridge, inboundMessage({
    messageId: "img-1",
    text: "",
    attachments: [{ id: "image-1", kind: "image", localPath: imagePath, raw: {} }],
  }));
  assert.equal(runs.length, 0);

  await sleep(60);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.prompt, "");
  assert.match(runs[0]?.attachmentNote ?? "", /only-image\.jpg/);
  bridge.stop();
});

function createBridge(mergeWindowMs: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-bridge-"));
  const config = loadConfig({
    WECHAT_CODEX_HOME: tmp,
    WECHAT_CODEX_CWD: tmp,
    WECHAT_CODEX_PAIRING_REQUIRED: "false",
    WECHAT_CODEX_INBOUND_MERGE_WINDOW_MS: String(mergeWindowMs),
  } as NodeJS.ProcessEnv, tmp);
  const sentText: string[] = [];
  const weixin = {
    start: async () => undefined,
    stop: () => undefined,
    status: () => ({ account: "wx-test", running: true }),
    sendText: async (_conversationId: string, content: string) => {
      sentText.push(content);
    },
    sendMedia: async () => undefined,
    sendTyping: async () => undefined,
  } as unknown as WeixinAdapter;
  const bridge = new WechatCodexBridge(config, weixin);
  const runs: Array<{ prompt: string; attachmentNote: string }> = [];
  (bridge as unknown as {
    runCodexBackend: (routeKey: string, prompt: string, attachmentNote: string) => Promise<unknown>;
  }).runCodexBackend = async (_routeKey: string, prompt: string, attachmentNote: string) => {
    runs.push({ prompt, attachmentNote });
    return { text: "done", threadId: "thread-1", rawLines: [], artifacts: [] };
  };
  return { bridge, runs, sentText, tmp };
}

function inboundMessage(patch: Partial<InboundMessage> = {}): InboundMessage {
  return {
    routeKey: "weixin:wx-test:direct:user-1",
    accountId: "wx-test",
    conversationId: "user-1",
    conversationKind: "direct",
    senderId: "user-1",
    messageId: "msg-1",
    text: "hello",
    attachments: [],
    contextToken: "ctx-1",
    timestamp: new Date(0).toISOString(),
    raw: {} as InboundMessage["raw"],
    ...patch,
  };
}

async function callHandleMessage(bridge: WechatCodexBridge, message: InboundMessage): Promise<void> {
  await (bridge as unknown as { handleMessage: (message: InboundMessage) => Promise<void> }).handleMessage(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
