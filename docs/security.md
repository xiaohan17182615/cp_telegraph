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

The iLink endpoints used here are not documented as a stable public API. The bridge may stop working if WeChat changes request headers, QR login, message schema, or rate limits.
