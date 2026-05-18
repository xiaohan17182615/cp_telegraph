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
