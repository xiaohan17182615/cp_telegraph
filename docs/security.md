# Security Notes

This bridge lets WeChat messages trigger a local Codex CLI process. Treat a paired chat like a remote control surface for the machine that runs the bridge.

Recommended defaults:

- Keep `WECHAT_CODEX_PAIRING_REQUIRED=true`.
- Keep `WECHAT_CODEX_GROUP_TRIGGER=@codex` or another explicit group prefix.
- Run the bridge as a normal user, not as administrator or root.
- Use a dedicated working directory for `WECHAT_CODEX_CWD`.
- Do not commit `.env`, `WECHAT_CODEX_HOME`, account JSON files, Codex credentials, or bridge state.
- Prefer a private machine or VPS you control.

The pairing code is printed only in the terminal and expires after 10 minutes. Pairing state is stored locally per WeChat route. Removing `bridge-state.json` clears trust decisions.

The WeChat token is saved in the account JSON file under `WECHAT_CODEX_HOME`. File mode is set to `0600` where the platform supports it, but Windows ACLs still depend on the user's profile permissions.

Inbound media is saved under `WECHAT_CODEX_HOME/state/uploads/inbound` when `WECHAT_CODEX_DOWNLOAD_MEDIA=true`. Treat those files as private chat data and keep the state directory out of source control.

The iLink endpoints used here are backed by Tencent's `@tencent-weixin/openclaw-weixin` plugin, but this bridge talks to the HTTP protocol directly instead of importing that plugin. Keep the bridge updated if Tencent changes headers, QR login, message schema, context-token behavior, or rate limits.
