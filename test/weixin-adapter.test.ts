import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage } from "../src/weixin/adapter.js";
import { MessageItemType, MessageType, type WeixinMessage } from "../src/weixin/types.js";
import type { StoredWeixinAccount } from "../src/weixin/account-store.js";

const account: StoredWeixinAccount = {
  accountId: "bot-a",
  token: "token",
  baseUrl: "https://example.test",
  userId: "self",
  savedAt: new Date(0).toISOString(),
};

test("normalizeMessage creates direct text route", () => {
  const raw: WeixinMessage = {
    message_id: "m1",
    from_user_id: "friend",
    create_time_ms: 1000,
    context_token: "ctx-1",
    message_type: MessageType.USER,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
  };
  const message = normalizeMessage(account, raw);
  assert.equal(message?.routeKey, "weixin:bot-a:direct:friend");
  assert.equal(message?.text, "hello");
  assert.equal(message?.contextToken, "ctx-1");
});

test("normalizeMessage keeps login user messages but drops bot messages", () => {
  const raw: WeixinMessage = {
    message_id: "m-self",
    from_user_id: "self",
    message_type: MessageType.USER,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "from login user" } }],
  };
  const message = normalizeMessage(account, raw);
  assert.equal(message?.senderId, "self");
  assert.equal(message?.text, "from login user");
  assert.equal(normalizeMessage(account, { from_user_id: "bot-a", item_list: [] }), null);
  assert.equal(normalizeMessage(account, { from_user_id: "friend", message_type: MessageType.BOT, item_list: [] }), null);
});

test("normalizeMessage captures group file metadata", () => {
  const raw: WeixinMessage = {
    message_id: "m2",
    from_user_id: "friend",
    group_id: "room",
    item_list: [{ type: MessageItemType.FILE, file_item: { file_name: "report.txt", len: "12" } }],
  };
  const message = normalizeMessage(account, raw);
  assert.equal(message?.routeKey, "weixin:bot-a:group:room");
  assert.equal(message?.attachments[0]?.kind, "file");
  assert.equal(message?.attachments[0]?.name, "report.txt");
});
