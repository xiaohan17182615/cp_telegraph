import test from "node:test";
import assert from "node:assert/strict";
import { WeixinClient, type FetchLike } from "../src/weixin/client.js";
import { MessageItemType, MessageState, MessageType } from "../src/weixin/types.js";

test("WeixinClient sends auth headers and base_info", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", fetchImpl });
  await client.sendMessage({
    token: "secret-token",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: "friend",
        client_id: "c1",
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hi" } }],
      },
    },
  });

  assert.equal(String(calls[0]?.input), "https://example.test/ilink/bot/sendmessage");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret-token");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.msg.to_user_id, "friend");
  assert.equal(body.base_info.bot_agent, "WechatCodexBridge/0.1.0");
});

test("WeixinClient treats long-poll abort as empty updates", async () => {
  const fetchImpl: FetchLike = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", fetchImpl });
  const response = await client.getUpdates({ token: "token", syncCursor: "cursor" });
  assert.deepEqual(response, { ret: 0, msgs: [], get_updates_buf: "cursor" });
});

test("WeixinClient supports getconfig and sendtyping", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    const url = String(input);
    const body = url.endsWith("/getconfig") ? { ret: 0, typing_ticket: "ticket" } : { ret: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", fetchImpl });
  const config = await client.getConfig({ token: "token", ilinkUserId: "friend", contextToken: "ctx" });
  assert.equal(config.typing_ticket, "ticket");
  await client.sendTyping({ token: "token", ilinkUserId: "friend", typingTicket: "ticket", status: 1 });
  assert.equal(String(calls[0]?.input), "https://example.test/ilink/bot/getconfig");
  assert.equal(String(calls[1]?.input), "https://example.test/ilink/bot/sendtyping");
  assert.equal(JSON.parse(String(calls[1]?.init?.body)).typing_ticket, "ticket");
});

test("WeixinClient supports getuploadurl", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ret: 0, upload_param: "upload-param" }), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", fetchImpl });
  const response = await client.getUploadUrl({
    token: "token",
    body: {
      filekey: "filekey",
      media_type: 1,
      to_user_id: "friend",
      rawsize: 12,
      rawfilemd5: "md5",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
    },
  });
  assert.equal(response.upload_param, "upload-param");
  assert.equal(String(calls[0]?.input), "https://example.test/ilink/bot/getuploadurl");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.filekey, "filekey");
  assert.equal(body.no_need_thumb, true);
  assert.equal(body.base_info.bot_agent, "WechatCodexBridge/0.1.0");
});
