import { WeixinClient } from "./client.js";
import { DEFAULT_BASE_URL } from "../config.js";
import { safeAccountId, type StoredWeixinAccount, type WeixinAccountStore } from "./account-store.js";

export interface QrLoginOptions {
  client: WeixinClient;
  store: WeixinAccountStore;
  botType: string;
  timeoutMs?: number;
  askVerifyCode?: (prompt: string) => Promise<string>;
  onQr?: (qrText: string) => Promise<void> | void;
  onStatus?: (status: string) => Promise<void> | void;
}

export async function runQrLogin(options: QrLoginOptions): Promise<StoredWeixinAccount> {
  const localTokenList = options.store.listAccountIds()
    .map((id) => options.store.load(id)?.token)
    .filter((token): token is string => Boolean(token))
    .slice(-10)
    .reverse();
  const qr = await options.client.getBotQr({ botType: options.botType, localTokenList });
  if (!qr.qrcode) throw new Error("WeChat QR login did not return qrcode");
  await options.onQr?.(qr.qrcode);

  const deadline = Date.now() + (options.timeoutMs ?? 480_000);
  let baseUrl: string | undefined;
  let verifyCode = "";
  let lastStatus = "";
  while (Date.now() < deadline) {
    const status = await options.client.getQrStatus({
      qrcode: qr.qrcode,
      baseUrl,
      verifyCode,
      timeoutMs: Math.min(35_000, Math.max(1000, deadline - Date.now())),
    });
    const statusText = String(status.status ?? "wait");
    if (statusText !== lastStatus) {
      lastStatus = statusText;
      await options.onStatus?.(statusText);
    }
    if (statusText === "scaned_but_redirect" && status.redirect_host) {
      baseUrl = `https://${status.redirect_host}`;
    } else if (statusText === "need_verifycode") {
      if (!options.askVerifyCode) throw new Error("WeChat requires verify code; run login in an interactive terminal");
      verifyCode = await options.askVerifyCode("Enter the verify code shown in WeChat: ");
    } else if (statusText === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id) throw new Error("WeChat confirmed login without token/account id");
      const account: StoredWeixinAccount = {
        accountId: safeAccountId(status.ilink_bot_id),
        token: status.bot_token,
        baseUrl: status.baseurl || baseUrl || DEFAULT_BASE_URL,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
      options.store.save(account);
      return account;
    } else if (statusText === "expired" || statusText === "verify_code_blocked") {
      throw new Error(`WeChat QR login failed: ${statusText}`);
    }
    await sleep(1000);
  }
  throw new Error("WeChat QR login timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
